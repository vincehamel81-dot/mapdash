import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import NameGate from './NameGate'
import ChatPanel from './ChatPanel'
import './index.css'

// App and ChatPanel are otherwise-independent siblings - this tiny bit of lifted state is just a
// command channel so ChatPanel's "Join" button can ask App to join a room, without either
// component needing to know anything else about the other.
function Root({ name, renameName }) {
  const [joinRequest, setJoinRequest] = useState(null)
  return (
    <>
      <App playerName={name} renameName={renameName} joinRequest={joinRequest} />
      <ChatPanel myName={name} onRequestJoin={(code) => setJoinRequest({ code, ts: Date.now() })} />
    </>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <NameGate>{(name, renameName) => <Root name={name} renameName={renameName} />}</NameGate>
  )
}
