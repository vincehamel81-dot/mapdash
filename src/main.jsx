import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import NameGate from './NameGate'
import ChatPanel from './ChatPanel'
import './index.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <NameGate>
      {(name, renameName) => (
        <>
          <App playerName={name} renameName={renameName} />
          <ChatPanel myName={name} />
        </>
      )}
    </NameGate>
  )
}
