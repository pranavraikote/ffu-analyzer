# FFU Analyzer

> AI-powered decision support for Swedish construction tender documents.

A wrong deadline missed. A requirement overlooked. An amendment that supersedes the original, i.e. read after the bid is submitted. These are real, costly mistakes in construction procurement. FFU Analyzer is built to prevent them.

## What It Does

Upload your FFU package with base documents, addenda, Excel schedules, and ask questions in plain language. The system finds the relevant sections, understands which documents supersede which, and returns a cited answer you can verify.

```
"What are the insurance requirements under AFC.5?"
"Are there any authority notifications required?"
"What does the latest amendment change about the handover date?"
```

Every answer cites its source document and section. If the information isn't in the documents, the system says so; it never guesses.

---

## How It Works

Standard RAG fails on documents like these. FFU packages are 100–1000+ pages, written in Swedish, structured around AMA codes, and issued with mid-bid amendments that invalidate earlier sections. Three concrete problems:

1. **Wrong chunks retrieved:** a user query in plain Swedish misses exact terminology buried in the document. **Fixed** with hybrid search: BM25 catches exact Swedish terms and AMA codes (e.g. `AFC.171`), vector search handles semantic similarity. Results are merged with Reciprocal Rank Fusion (RRF).

2. **Right chunks, wrong answer:** LLMs degrade on information buried in the middle of long contexts. **Fixed** with lost-in-the-middle reordering: the most relevant chunks are placed first and last, not in the middle.

3. **Amendment blindness:** if both a base document and an amendment are retrieved, a naive system picks arbitrarily. **Fixed** with amendment awareness: the system auto-detects which documents are amendments, expands retrieval to surface both versions, labels them explicitly in context, and instructs the LLM which supersedes.

---

## Key Features

| Feature | Detail |
|---|---|
| Hybrid search | FAISS HNSW (cosine) + BM25 with RRF merge |
| AMA-aware chunking | Chunks respect AMA code boundaries, not token counts |
| Amendment handling | LLM-classified at upload, expanded K, conditional system prompt |
| Grounded answers | Every claim cites `[Doc, Section]` — no hallucination on facts |
| Multi-turn conversation | Follow-up questions are contextualized automatically |
| Streaming responses | Answers stream token-by-token via SSE |
| Incremental indexing | Re-upload only adds new documents, doesn't reindex existing ones |
| Observability | Per-request latency and `not_found` rate tracked at `/stats` |

---

## Getting Started

**Requirements:** Python 3.11+ and Node 20+

**1. API key**

Create a `.env` file in the `ffu-analyzer/` root:

```env
OPENAI_API_KEY=sk-your-key-here
```

**2. Backend**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

**3. Frontend**

```bash
cd frontend
npm install
npm run dev
```

**4. Open** `http://localhost:5173`

Drop your FFU documents into the upload zone. The system auto-detects base documents vs amendments — toggle the badge on any file if the detection is wrong. Click **Upload & Index**, then start asking questions.

---

## Project Structure

```
ffu-analyzer/
├── backend/
│   ├── main.py          # FastAPI app — all endpoints, RAG pipeline, chunking
│   ├── requirements.txt
│   └── data/            # Uploaded documents (gitignored)
└── frontend/
    └── src/
        └── main.tsx     # Single-file React UI
```

---

## Observability

```bash
curl http://localhost:8000/api/stats
```

Returns average latency by stage (context rewrite, embed, retrieval, generation) and `not_found` rate across the last 50 requests.

```bash
curl -X POST http://localhost:8000/api/debug -H "Content-Type: application/json" \
  -d '{"message": "AFC.171"}'
```

Returns the raw chunks that would be retrieved for a given query, useful for diagnosing retrieval misses.

---

## Reflection

**Why I chose to build it**

Construction procurement is a domain where a missed requirement or misread amendment has direct financial consequences. A generic RAG system fails here in predictable ways: vocabulary mismatch on Swedish terminology, LLM attention degrading on long contexts, amendments silently overriding base documents. The interesting problem was fixing each failure mode systematically, building something defensible rather than a demo that works on clean inputs.

**What I would do next**

- **Proactive requirement extraction:** on upload, automatically surface deadlines, submission requirements, and penalty clauses as a structured checklist. The biggest risk in procurement isn't a wrong answer — it's a requirement nobody thought to ask about.
- **Context optimization:** hierarchical parent-child chunking: embed small chunks for precise retrieval, return the larger parent section to the LLM, with a token budget replacing the current fixed `TOP_K` slice.
- **Multi-modal support:** enable table extraction (currently disabled) so prices, quantities, and penalty amounts in FFU tables are indexed and retrievable.
- **Multi-tenancy:** move from a single shared index to per-project isolation, with Pinecone or pgvector replacing FAISS for scalable concurrent access.