import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

type Source = { doc: string; section: string }
type Message = { role: 'user' | 'assistant'; content: string; sources?: Source[] }
type UploadState = 'idle' | 'uploading' | 'indexing' | 'ready' | 'error'

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
  sourceTag: { fontSize: 11, padding: '3px 8px', borderRadius: 12, background: '#eef2ff', color: '#4f46e5', border: '1px solid #c7d2fe', cursor: 'default' as const },
  form:      { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 },
  input:     { padding: '12px 16px', border: '1px solid #ddd', borderRadius: 8, font: 'inherit', fontSize: 14, outline: 'none' },
  send:      { padding: '12px 20px', border: 'none', borderRadius: 8, background: '#1a1a1a', color: '#fff', font: 'inherit', fontSize: 14, cursor: 'pointer' },
  dot:       { display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' },
}

const uploadZoneStyle = (dragging: boolean, state: UploadState): React.CSSProperties => ({
  border: `2px dashed ${dragging ? '#1a1a1a' : state === 'ready' ? '#16a34a' : state === 'error' ? '#dc2626' : '#ddd'}`,
  borderRadius: 8,
  padding: '20px 16px',
  textAlign: 'center',
  cursor: state === 'uploading' || state === 'indexing' ? 'default' : 'pointer',
  background: dragging ? '#f0f0f0' : '#fafafa',
  transition: 'border-color 0.15s, background 0.15s',
  fontSize: 13,
  color: state === 'ready' ? '#16a34a' : state === 'error' ? '#dc2626' : '#666',
})

function Spinner() {
  return <span style={ui.dot}>⋯</span>
}

function App() {
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

  const handleFiles = async (files: FileList) => {
    if (!files.length) return
    const allowed = Array.from(files).filter(f => f.name.endsWith('.pdf') || f.name.endsWith('.xlsx'))
    if (!allowed.length) {
      setUploadState('error')
      setUploadLabel('Only PDF and Excel files are supported')
      return
    }

    // Upload
    setUploadState('uploading')
    setUploadLabel(`Uploading ${allowed.length} file${allowed.length > 1 ? 's' : ''}…`)
    const form = new FormData()
    allowed.forEach(f => form.append('files', f))
    try {
      await fetch('/api/upload', { method: 'POST', body: form })
    } catch {
      setUploadState('error')
      setUploadLabel('Upload failed — check server connection')
      return
    }

    // Auto-process
    setUploadState('indexing')
    setUploadLabel('Indexing documents…')
    try {
      const data = await fetch('/api/process', { method: 'POST' }).then(r => r.json())
      setUploadState('ready')
      setUploadLabel(
        data.status === 'up_to_date'
          ? `Ready — documents already indexed`
          : `Ready — ${data.new} new document${data.new !== 1 ? 's' : ''} indexed`
      )
    } catch {
      setUploadState('error')
      setUploadLabel('Indexing failed — check server logs')
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
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
                const last = updated[updated.length - 1]
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

        {/* Upload zone */}
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
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.xlsx"
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) { handleFiles(e.target.files); e.target.value = '' } }}
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
                      <span key={j} style={ui.sourceTag} title={s.doc}>
                        {s.section || s.doc.replace('.pdf', '').replace('.xlsx', '')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
          {streamStatus === 'searching' && (
            <div style={ui.asstWrap}>
              <div style={ui.status}><Spinner /> Searching documents…</div>
            </div>
          )}
          {streamStatus === 'reading' && (
            <div style={ui.asstWrap}>
              <div style={ui.status}><Spinner /> Reading sources…</div>
            </div>
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
