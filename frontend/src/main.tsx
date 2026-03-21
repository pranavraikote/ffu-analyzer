import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

type Source      = { doc: string; section: string; doc_type?: string }
type Message     = { role: 'user' | 'assistant'; content: string; sources?: Source[] }
type UploadState = 'idle' | 'uploading' | 'indexing' | 'ready' | 'error'
type StagedFile  = { file: File; docType: 'base' | 'addendum'; overridden: boolean }

const ui = {
  page:      { margin: 0, minHeight: '100vh', background: '#f0f0f0', color: '#1a1a1a', fontFamily: 'system-ui, sans-serif' },
  app:       { maxWidth: 820, margin: '0 auto', padding: 24, display: 'grid', gap: 12 },
  header:    { fontSize: 20, fontWeight: 700, color: '#1a1a1a', marginBottom: 4 },
  chat:      { minHeight: 400, maxHeight: 600, padding: 16, border: '1px solid #ddd', borderRadius: 8, background: '#fff', overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: 12 },
  userWrap:  { display: 'flex', justifyContent: 'flex-end' },
  asstWrap:  { display: 'flex', justifyContent: 'flex-start', flexDirection: 'column' as const, gap: 4 },
  userBub:   { maxWidth: '72%', padding: '10px 14px', borderRadius: 16, background: '#1a1a1a', color: '#fff', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' as const },
  asstBub:   { maxWidth: '82%', padding: '12px 16px', borderRadius: 16, background: '#f5f5f5', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' as const, border: '1px solid #e8e8e8' },
  status:    { fontSize: 12, color: '#888', fontStyle: 'italic', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 },
  sources:   { display: 'flex', flexWrap: 'wrap' as const, gap: 6, paddingLeft: 4, marginTop: 4 },
  form:      { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 },
  input:     { padding: '12px 16px', border: '1px solid #ddd', borderRadius: 8, font: 'inherit', fontSize: 14, outline: 'none' },
  send:      { padding: '12px 20px', border: 'none', borderRadius: 8, background: '#1a1a1a', color: '#fff', font: 'inherit', fontSize: 14, cursor: 'pointer' },
  dot:       { display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' },
}

const sourceTagStyle = (docType?: string): React.CSSProperties =>
  docType === 'addendum'
    ? { fontSize: 11, padding: '3px 8px', borderRadius: 12, background: '#fffbeb', color: '#d97706', border: '1px solid #fde68a', cursor: 'default' as const }
    : { fontSize: 11, padding: '3px 8px', borderRadius: 12, background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', cursor: 'default' as const }

const uploadZoneStyle = (dragging: boolean, state: UploadState): React.CSSProperties => ({
  border: `2px dashed ${dragging ? '#1a1a1a' : state === 'ready' ? '#16a34a' : state === 'error' ? '#dc2626' : '#ddd'}`,
  borderRadius: 8,
  padding: '20px 16px',
  textAlign: 'center',
  cursor: state === 'uploading' || state === 'indexing' ? 'default' : 'pointer',
  background: dragging ? '#f0f0f0' : '#fafafa',
  transition: 'border-color 0.15s',
  fontSize: 13,
  color: state === 'ready' ? '#16a34a' : state === 'error' ? '#dc2626' : '#666',
})

function Spinner() {
  return <span style={ui.dot}>⋯</span>
}

function App() {
  const [staged, setStaged]           = useState<StagedFile[]>([])
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [uploadLabel, setUploadLabel] = useState('Drop PDF or Excel files here, or click to browse')
  const [dragging, setDragging]       = useState(false)
  const [input, setInput]             = useState('')
  const [streamStatus, setStreamStatus] = useState('')
  const [messages, setMessages]       = useState<Message[]>([])
  const chatRef   = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const scrollBottom = () => setTimeout(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' })
  }, 0)

  const stageFiles = (files: FileList) => {
    const allowed = Array.from(files).filter(f => f.name.endsWith('.pdf') || f.name.endsWith('.xlsx'))
    if (!allowed.length) {
      setUploadState('error')
      setUploadLabel('Only PDF and Excel files are supported')
      return
    }
    setStaged(allowed.map(f => ({ file: f, docType: 'base' as const, overridden: false })))
    setUploadState('idle')
  }

  const toggleDocType = (i: number) =>
    setStaged(s => s.map((f, idx) => idx === i
      ? { ...f, docType: f.docType === 'base' ? 'addendum' : 'base', overridden: true }
      : f))

  const uploadStaged = async () => {
    if (!staged.length) return
    setUploadState('uploading')
    setUploadLabel(`Uploading ${staged.length} file${staged.length > 1 ? 's' : ''}…`)

    const form = new FormData()
    staged.forEach(s => form.append('files', s.file))
    const manualOverrides = Object.fromEntries(staged.filter(s => s.overridden).map(s => [s.file.name, s.docType]))
    form.append('overrides', JSON.stringify(manualOverrides))

    let docTypes: Record<string, string> = {}
    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: form })
      const data = await res.json()
      docTypes   = data.doc_types ?? {}
    } catch {
      setUploadState('error')
      setUploadLabel('Upload failed — check server connection')
      return
    }

    const base      = Object.values(docTypes).filter(t => t === 'base').length
    const amendment = Object.values(docTypes).filter(t => t === 'addendum').length
    const summary   = [base && `${base} base`, amendment && `${amendment} amendment`].filter(Boolean).join(', ')

    setStaged([])
    setUploadState('indexing')
    setUploadLabel('Indexing documents…')
    try {
      const data = await fetch('/api/process', { method: 'POST' }).then(r => r.json())
      setUploadState('ready')
      setUploadLabel(
        data.status === 'up_to_date'
          ? 'Ready — documents already indexed'
          : `Ready — ${summary} indexed`
      )
    } catch {
      setUploadState('error')
      setUploadLabel('Indexing failed — check server logs')
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    stageFiles(e.dataTransfer.files)
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || streamStatus) return
    const history = [...messages]
    const query   = input.trim()
    setInput('')
    setMessages([...history, { role: 'user', content: query }])
    setStreamStatus('searching')
    scrollBottom()

    try {
      const resp    = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: query, history: history.map(({ role, content }) => ({ role, content })) }),
      })
      const reader  = resp.body!.getReader()
      const decoder = new TextDecoder()
      let content   = ''
      let sources: Source[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'sources') {
              sources = event.sources
              setStreamStatus('reading')
            } else if (event.type === 'token') {
              setStreamStatus('')
              content += event.content
              setMessages(m => {
                const updated = [...m]
                const last    = updated[updated.length - 1]
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content, sources }
                } else {
                  updated.push({ role: 'assistant', content, sources })
                }
                return updated
              })
              scrollBottom()
            }
          } catch {}
        }
      }
    } finally {
      setStreamStatus('')
      scrollBottom()
    }
  }

  return (
    <div style={ui.page}>
      <style>{`@keyframes pulse { 0%,100%{opacity:.3} 50%{opacity:1} }`}</style>
      <div style={ui.app}>
        <div style={ui.header}>FFU Analyzer</div>

        {/* Upload zone / staging */}
        {staged.length > 0 ? (
          <div style={{ border: '1px solid #ddd', borderRadius: 8, background: '#fafafa', padding: 16, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>
              Type is auto-detected — toggle if incorrect. <strong>Amendment</strong> = document that modifies or supersedes the original.
            </div>
            {staged.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#1a1a1a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 500 }}>{s.file.name}</span>
                <button
                  onClick={() => toggleDocType(i)}
                  title="Click to toggle document type"
                  style={{
                    padding: '2px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer', border: 'none',
                    background: s.docType === 'addendum' ? '#fffbeb' : '#eef2ff',
                    color:      s.docType === 'addendum' ? '#d97706'  : '#4f46e5',
                    outline:    `1px solid ${s.docType === 'addendum' ? '#fde68a' : '#c7d2fe'}`,
                  }}
                >
                  {s.docType === 'addendum' ? 'Amendment' : 'Base doc'}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={uploadStaged} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#1a1a1a', color: '#fff', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>
                Upload & Index
              </button>
              <button onClick={() => setStaged([])} style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', font: 'inherit', fontSize: 13, cursor: 'pointer', color: '#666' }}>
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div
            style={uploadZoneStyle(dragging, uploadState)}
            onClick={() => uploadState !== 'uploading' && uploadState !== 'indexing' && fileInput.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {(uploadState === 'uploading' || uploadState === 'indexing') && <Spinner />}{' '}
            {uploadLabel}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.xlsx"
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) { stageFiles(e.target.files); e.target.value = '' } }}
        />

        {/* Chat */}
        <div style={ui.chat} ref={chatRef}>
          {messages.map((msg, i) =>
            msg.role === 'user' ? (
              <div key={i} style={ui.userWrap}>
                <div style={ui.userBub}>{msg.content}</div>
              </div>
            ) : (
              <div key={i} style={ui.asstWrap}>
                <div style={ui.asstBub}>{msg.content}</div>
                {msg.sources && msg.sources.length > 0 && (
                  <div style={ui.sources}>
                    {msg.sources.map((s, j) => (
                      <span key={j} style={sourceTagStyle(s.doc_type)} title={s.doc}>
                        {s.section || s.doc.replace('.pdf', '').replace('.xlsx', '')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
          {streamStatus === 'searching' && (
            <div style={ui.asstWrap}><div style={ui.status}><Spinner /> Searching documents…</div></div>
          )}
          {streamStatus === 'reading' && (
            <div style={ui.asstWrap}><div style={ui.status}><Spinner /> Reading sources…</div></div>
          )}
        </div>

        <form onSubmit={send} style={ui.form}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about the FFU documents…"
            style={ui.input}
            disabled={!!streamStatus || uploadState === 'uploading' || uploadState === 'indexing'}
          />
          <button style={ui.send} disabled={!!streamStatus || uploadState === 'uploading' || uploadState === 'indexing'}>Send</button>
        </form>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
