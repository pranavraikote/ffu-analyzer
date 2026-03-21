from __future__ import annotations

import os, json, re, logging, asyncio, time, uuid
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor, as_completed

import fitz
import numpy as np
import faiss
import pymupdf4llm
import openpyxl
from fastapi import FastAPI, APIRouter, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from dotenv import load_dotenv
from rank_bm25 import BM25Okapi

# ── Config ─────────────────────────────────────────────────────────────────────

EMBED_MODEL     = "text-embedding-3-small"
EMBED_DIM       = 1536
CHAT_MODEL      = "gpt-4o"
FAST_MODEL      = "gpt-4o-mini"
TOP_K_FETCH     = 20
TOP_K_FINAL     = 5
EMBED_BATCH     = 100
MAX_EMBED_CHARS = 6000
MIN_CHUNK       = 150
MAX_CHUNK       = 2500
HNSW_M          = 16
HNSW_EF_BUILD   = 200
HNSW_EF_SEARCH  = 50

AMA_RE      = re.compile(r'^\*\*([A-Z]{1,4}(?:\.[0-9]{1,4})*)\*\*', re.MULTILINE)
PAGE_HDR_RE = re.compile(r'DOKUMENT STATUS\s*\n(?:.*?\n){0,20}?(?=\*\*[A-Z]|#{1,6}\s|\Z)', re.DOTALL)
HEADING_RE  = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)
AMA_IN_TEXT = re.compile(r'\b([A-Z]{1,4}(?:\.[0-9]{1,4})+)\b')

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
client      = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

_persist       = Path(os.environ.get("DATA_DIR", Path(__file__).parent))
data_dir       = _persist / "data"
CHUNKS_FILE    = _persist / "chunks.json"
EMBEDS_FILE    = _persist / "embeddings.npy"
FAISS_FILE     = _persist / "ffu.index"
DOC_TYPES_FILE = _persist / "doc_types.json"

TOP_K_ADDENDUM = 8  # expanded K when addendum chunks are present

ADDENDUM_PROMPT = """
Some retrieved sections include both original document content and amendments.
Where both versions exist, clearly present:
- What the original document states
- What the amendment changes it to
Always make clear that the amendment supersedes the original."""

CLASSIFY_PROMPT = """\
Classify this construction document as either 'base' or 'addendum'.
An addendum modifies, corrects, or supplements an existing base document \
(also called amendment, tillägg, komplettering, ändring, KFU, rättelse).
Reply with exactly one word: base or addendum."""

async def classify_doc_type(filename: str, path: Path) -> str:
    snippet = ""
    try:
        if filename.endswith(".pdf"):
            doc = fitz.open(str(path))
            for page in doc[:3]:
                snippet += page.get_text()
                if len(snippet) >= 1000:
                    break
            doc.close()
        snippet = snippet[:1000].strip()
    except Exception:
        pass
    if not snippet:
        return "base"
    try:
        resp = await client.chat.completions.create(
            model=FAST_MODEL, temperature=0, max_tokens=5,
            messages=[
                {"role": "system", "content": CLASSIFY_PROMPT},
                {"role": "user",   "content": f"Filename: {filename}\n\n{snippet}"},
            ],
        )
        return "addendum" if "addendum" in resp.choices[0].message.content.lower() else "base"
    except Exception:
        return "base"

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# ── Observability ───────────────────────────────────────────────────────────────

_request_log = deque(maxlen=50)

def log_event(rid, stage, **fields):
    logger.info(json.dumps({"request_id": rid, "stage": stage, **fields}))

# ── In-memory index ────────────────────────────────────────────────────────────

_bm25        = None
_chunk_index = []
_faiss_index = None

# ── Chunking ───────────────────────────────────────────────────────────────────

def parent_codes(code):
    parts, parents = code.split("."), []
    for i in range(len(parts) - 1, 0, -1):
        parents.append(".".join(parts[:i]))
    for l in range(len(parts[0]) - 1, 0, -1):
        parents.append(parts[0][:l])
    return parents

def _split_long(text, max_chars):
    if len(text) <= max_chars:
        return [text]
    paras = re.split(r"\n{2,}", text)
    segments, current = [], ""
    for para in paras:
        if len(current) + len(para) > max_chars and current:
            segments.append(current.strip())
            current = para
        else:
            current += ("\n\n" if current else "") + para
    if current.strip():
        segments.append(current.strip())
    return segments or [text[:max_chars]]

def ama_chunks(doc_name, text):
    text    = PAGE_HDR_RE.sub("", text)
    matches = list(AMA_RE.finditer(text))
    chunks  = []
    for i, m in enumerate(matches):
        code  = m.group(1)
        end   = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body  = text[m.start():end].strip()
        if len(body) < MIN_CHUNK and chunks and len(chunks[-1]["text"]) + len(body) < MAX_CHUNK:
            chunks[-1]["text"] += "\n\n" + body
            continue
        for seg in _split_long(body, MAX_CHUNK):
            chunks.append({"doc_name": doc_name, "text": seg,
                           "metadata": {"ama_code": code, "parent_codes": parent_codes(code), "doc_name": doc_name}})
    return chunks

def heading_chunks(doc_name, text):
    matches = list(HEADING_RE.finditer(text))
    if not matches:
        return [{"doc_name": doc_name, "text": seg, "metadata": {"doc_name": doc_name}}
                for seg in _split_long(text.strip(), MAX_CHUNK)]
    chunks = []
    for i, m in enumerate(matches):
        heading = re.sub(r'\*+', '', m.group(2)).strip()
        end     = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body    = text[m.start():end].strip()
        if len(body) < MIN_CHUNK and chunks and len(chunks[-1]["text"]) + len(body) < MAX_CHUNK:
            chunks[-1]["text"] += "\n\n" + body
            continue
        for seg in _split_long(body, MAX_CHUNK):
            chunks.append({"doc_name": doc_name, "text": seg,
                           "metadata": {"section": heading, "doc_name": doc_name}})
    return chunks

def chunk_document(doc_name, text):
    return ama_chunks(doc_name, text) if len(AMA_RE.findall(text)) >= 5 else heading_chunks(doc_name, text)

def xlsx_to_chunks(path):
    wb, chunks = openpyxl.load_workbook(path, data_only=True), []
    for sheet in wb.worksheets:
        rows = [" | ".join(str(v) for v in row if v is not None)
                for row in sheet.iter_rows(values_only=True)]
        rows = [r for r in rows if r.strip()]
        if rows:
            for seg in _split_long(f"Sheet: {sheet.title}\n" + "\n".join(rows), MAX_CHUNK):
                chunks.append({"doc_name": path.name, "text": seg,
                               "metadata": {"sheet": sheet.title, "doc_name": path.name}})
    return chunks

# ── Embeddings ─────────────────────────────────────────────────────────────────

async def embed_texts(texts):
    results = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = [t[:MAX_EMBED_CHARS] for t in texts[i : i + EMBED_BATCH]]
        resp  = await client.embeddings.create(model=EMBED_MODEL, input=batch)
        results.extend(np.array(d.embedding, dtype=np.float32) for d in resp.data)
    return results

# ── Search ─────────────────────────────────────────────────────────────────────

def tokenize(text):
    return re.findall(r'[a-zåäö0-9]+(?:\.[a-z0-9]+)*', text.lower())

def vector_search(query_vec, top_k):
    if _faiss_index is None or _faiss_index.ntotal == 0:
        return []
    q = query_vec.reshape(1, -1).copy()
    faiss.normalize_L2(q)
    scores, indices = _faiss_index.search(q, top_k)
    return [(int(idx), float(s)) for idx, s in zip(indices[0], scores[0]) if idx >= 0]

def bm25_search(query, top_k):
    if _bm25 is None or not _chunk_index:
        return []
    scores = _bm25.get_scores(tokenize(query))
    top    = np.argsort(scores)[::-1][:top_k]
    return [(int(i), float(scores[i])) for i in top]

def rrf_merge(rankings, k=60):
    scores = {}
    for ranking in rankings:
        for rank, idx in enumerate(ranking):
            scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores, key=lambda x: scores[x], reverse=True)

def reorder_chunks(chunks):
    if len(chunks) <= 2:
        return chunks
    result, lo, hi = [None] * len(chunks), 0, len(chunks) - 1
    for i, chunk in enumerate(chunks):
        if i % 2 == 0:
            result[lo] = chunk; lo += 1
        else:
            result[hi] = chunk; hi -= 1
    return result

# ── Index rebuild ──────────────────────────────────────────────────────────────

def rebuild_index():
    global _bm25, _chunk_index, _faiss_index
    if not CHUNKS_FILE.exists():
        return
    with open(CHUNKS_FILE) as f:
        _chunk_index = json.load(f)
    if FAISS_FILE.exists():
        _faiss_index = faiss.read_index(str(FAISS_FILE))
        _faiss_index.hnsw.efSearch = HNSW_EF_SEARCH
    _bm25 = BM25Okapi([tokenize(c["text"]) for c in _chunk_index])
    logger.info(f"Index ready: {len(_chunk_index)} chunks")

# ── App ────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(rebuild_index)
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
api = APIRouter(prefix="/api")

# ── /upload ────────────────────────────────────────────────────────────────────

@api.post("/upload")
async def upload(files: list[UploadFile] = File(...), overrides: str = Form("{}")):
    data_dir.mkdir(exist_ok=True)
    manual   = json.loads(overrides)
    type_map = json.loads(DOC_TYPES_FILE.read_text()) if DOC_TYPES_FILE.exists() else {}
    saved    = []
    for file in files:
        if not file.filename:
            continue
        (data_dir / file.filename).write_bytes(await file.read())
        saved.append(file.filename)

    async def resolve_type(filename):
        if filename in manual:
            return filename, manual[filename]
        return filename, await classify_doc_type(filename, data_dir / filename)

    for filename, doc_type in await asyncio.gather(*[resolve_type(f) for f in saved]):
        type_map[filename] = doc_type

    DOC_TYPES_FILE.write_text(json.dumps(type_map, ensure_ascii=False, indent=2))
    logger.info(f"Uploaded: {saved}")
    return {"saved": saved, "count": len(saved), "doc_types": {f: type_map[f] for f in saved}}

# ── /process ───────────────────────────────────────────────────────────────────

@api.post("/process")
async def process():
    pdf_paths  = sorted(data_dir.rglob("*.pdf"))
    xlsx_paths = sorted(data_dir.rglob("*.xlsx"))

    existing_chunks, existing_vecs = [], None
    if CHUNKS_FILE.exists() and EMBEDS_FILE.exists():
        with open(CHUNKS_FILE) as f:
            existing_chunks = json.load(f)
        existing_vecs = np.load(str(EMBEDS_FILE))

    already_indexed = {c["doc_name"] for c in existing_chunks}
    new_pdfs  = [p for p in pdf_paths  if p.name not in already_indexed]
    new_xlsx  = [p for p in xlsx_paths if p.name not in already_indexed]

    if not new_pdfs and not new_xlsx:
        return {"status": "up_to_date", "chunks": len(existing_chunks), "new": 0}

    def parse_pdf(path):
        return path.name, pymupdf4llm.to_markdown(str(path), ignore_images=True, ignore_graphics=True)

    raw_docs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(parse_pdf, p): p for p in new_pdfs}
        for fut in as_completed(futures):
            try:
                raw_docs.append(fut.result())
                logger.info(f"Parsed {futures[fut].name}")
            except Exception as e:
                logger.warning(f"Failed to parse {futures[fut].name}: {e}")

    type_map   = json.loads(DOC_TYPES_FILE.read_text()) if DOC_TYPES_FILE.exists() else {}
    new_chunks = []
    for doc_name, text in raw_docs:
        chunks = chunk_document(doc_name, text)
        for c in chunks:
            c["metadata"]["doc_type"] = type_map.get(doc_name, "base")
        new_chunks.extend(chunks)
    for path in new_xlsx:
        chunks = xlsx_to_chunks(path)
        for c in chunks:
            c["metadata"]["doc_type"] = type_map.get(path.name, "base")
        new_chunks.extend(chunks)

    if not new_chunks:
        return {"status": "up_to_date", "chunks": len(existing_chunks), "new": 0}

    new_vecs     = await embed_texts([c["text"] for c in new_chunks])
    new_vecs_arr = np.vstack(new_vecs).astype(np.float32)
    all_chunks   = existing_chunks + new_chunks
    all_vecs     = np.vstack([existing_vecs, new_vecs_arr]) if existing_vecs is not None else new_vecs_arr

    with open(CHUNKS_FILE, "w") as f:
        json.dump(all_chunks, f, ensure_ascii=False, indent=2)
    np.save(str(EMBEDS_FILE), all_vecs)

    index = faiss.IndexHNSWFlat(EMBED_DIM, HNSW_M, faiss.METRIC_INNER_PRODUCT)
    index.hnsw.efConstruction = HNSW_EF_BUILD
    index.hnsw.efSearch       = HNSW_EF_SEARCH
    vecs = all_vecs.copy()
    faiss.normalize_L2(vecs)
    index.add(vecs)
    faiss.write_index(index, str(FAISS_FILE))

    await asyncio.to_thread(rebuild_index)
    return {"status": "ok", "chunks": len(all_chunks), "new": len(raw_docs) + len(new_xlsx)}

# ── /debug ─────────────────────────────────────────────────────────────────────

@api.post("/debug")
async def debug(body: dict):
    query      = body.get("message", "").strip()
    q_vec      = (await embed_texts([query]))[0]
    merged_ids = rrf_merge([[i for i, _ in vector_search(q_vec, TOP_K_FETCH)],
                             [i for i, _ in bm25_search(query, TOP_K_FETCH)]])[:TOP_K_FINAL]
    chunks     = [_chunk_index[i] for i in merged_ids if i < len(_chunk_index)]
    return {"chunks": [{"doc": c["doc_name"],
                        "section": c["metadata"].get("ama_code") or c["metadata"].get("section", ""),
                        "text_preview": c["text"][:200]} for c in chunks]}

# ── /chat ──────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are an expert analyst of Swedish construction tender documents (FFU — förfrågningsunderlag).
Answer based ONLY on the document excerpts provided below.
For every claim, cite its source as [Doc: <filename>, Section: <code or heading>].
If the answer cannot be found in the excerpts, respond exactly:
"Information not found in the provided documents."
Do not infer or guess beyond what is explicitly stated.
Always answer in the same language as the question.\
"""

@api.post("/chat")
async def chat(body: dict):
    query   = body.get("message", "").strip()
    history = body.get("history", [])
    if not query:
        return StreamingResponse(iter([]), media_type="text/event-stream")

    rid, t_start = uuid.uuid4().hex[:8], time.monotonic()

    t0 = time.monotonic()
    retrieval_query = query
    if history:
        try:
            resp = await client.chat.completions.create(
                model=FAST_MODEL, temperature=0,
                messages=[
                    {"role": "system", "content": "Rewrite the follow-up as a standalone search query capturing full context. Return only the query."},
                    *history[-4:],
                    {"role": "user", "content": f"Follow-up: {query}"}
                ]
            )
            retrieval_query = resp.choices[0].message.content.strip()
        except Exception:
            pass
    context_ms = int((time.monotonic() - t0) * 1000)

    t0       = time.monotonic()
    q_vec    = (await embed_texts([retrieval_query]))[0]
    embed_ms = int((time.monotonic() - t0) * 1000)

    t0         = time.monotonic()
    all_ids    = rrf_merge([[i for i, _ in vector_search(q_vec, TOP_K_FETCH)],
                             [i for i, _ in bm25_search(retrieval_query, TOP_K_FETCH)]])
    candidates = [_chunk_index[i] for i in all_ids[:TOP_K_FINAL] if i < len(_chunk_index)]

    # If any addendum chunk is present, expand K to surface both versions
    has_addendum = any(c["metadata"].get("doc_type") == "addendum" for c in candidates)
    if has_addendum:
        candidates = [_chunk_index[i] for i in all_ids[:TOP_K_ADDENDUM] if i < len(_chunk_index)]
    retrieval_ms = int((time.monotonic() - t0) * 1000)

    final_chunks           = reorder_chunks(candidates)
    context_parts, sources = [], []
    for chunk in final_chunks:
        meta     = chunk["metadata"]
        section  = meta.get("ama_code") or meta.get("section") or chunk["doc_name"]
        if not meta.get("ama_code") and section.upper() in ("INNEHÅLLSFÖRTECKNING", ""):
            m = AMA_IN_TEXT.search(chunk["text"])
            if m:
                section = m.group(1)
        doc_type = meta.get("doc_type", "base")
        label    = "AMENDMENT" if doc_type == "addendum" else "Doc"
        context_parts.append(f"[{label}: {chunk['doc_name']}, Section: {section}]\n{chunk['text']}")
        sources.append({"doc": chunk["doc_name"], "section": section, "doc_type": doc_type})

    seen, unique_sources = set(), []
    for s in sources:
        key = (s["doc"], s["section"])
        if key not in seen:
            seen.add(key)
            unique_sources.append(s)
    sources = unique_sources

    system_content = SYSTEM_PROMPT + (ADDENDUM_PROMPT if has_addendum else "")
    messages = [
        {"role": "system", "content": system_content},
        *history[-10:],
        {"role": "user", "content": "Context:\n\n" + "\n\n---\n\n".join(context_parts) + f"\n\nQuestion: {query}"},
    ]

    async def event_generator():
        yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"
        full_response = []
        try:
            stream = await client.chat.completions.create(model=CHAT_MODEL, messages=messages, stream=True)
            async for event in stream:
                delta = event.choices[0].delta.content
                if delta:
                    full_response.append(delta)
                    yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
        except Exception as e:
            logger.error(f"Stream error [{rid}]: {e}")
            yield f"data: {json.dumps({'type': 'token', 'content': 'Error generating response. Please try again.'})}\n\n"
        yield "data: [DONE]\n\n"

        answer    = "".join(full_response)
        total_ms  = int((time.monotonic() - t_start) * 1000)
        record    = {"request_id": rid, "query": query, "context_ms": context_ms,
                     "embed_ms": embed_ms, "retrieval_ms": retrieval_ms,
                     "total_ms": total_ms, "chunks": len(final_chunks),
                     "not_found": "not found in the provided documents" in answer.lower()}
        _request_log.append(record)
        log_event(rid, "complete", **{k: v for k, v in record.items() if k != "request_id"})

    return StreamingResponse(event_generator(), media_type="text/event-stream")

# ── /stats ─────────────────────────────────────────────────────────────────────

@api.get("/stats")
async def stats():
    if not _request_log:
        return {"total_requests": 0}
    logs = list(_request_log)
    return {
        "total_requests": len(logs),
        "avg_total_ms":   int(sum(r["total_ms"] for r in logs) / len(logs)),
        "not_found_rate": round(sum(r["not_found"] for r in logs) / len(logs), 3),
        "recent":         logs[-10:][::-1],
    }

app.include_router(api)

_static = Path(__file__).parent / "static"
if _static.exists():
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")
