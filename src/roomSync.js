import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'

export function generateRoomCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += letters[Math.floor(Math.random() * letters.length)]
  }
  return code
}

// Converts between the DB row shape (queryable top-level columns + a jsonb blob for the rest)
// and the plain room object the rest of App.jsx already works with, so createRoom/joinRoom/
// updateRoom/leaveRoom/etc. don't need to know a database is involved at all.
function rowToRoom(row) {
  const state = row.state || {}
  return {
    code: row.code,
    mode: row.mode,
    status: row.status,
    host: row.host_name,
    maxPlayers: row.max_players,
    players: state.players || [],
    clouds: state.clouds || [],
    items: state.items || [],
    roundStartedAt: state.roundStartedAt ?? null,
    itName: state.itName ?? null,
    // Fallback covers any room saved under the old singular-winnerId shape during rollout.
    winners: state.winners || (state.winnerId ? [state.winnerId] : []),
    createdAt: state.createdAt ?? new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime()
  }
}

function roomToRow(room) {
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    host_name: room.host,
    max_players: room.maxPlayers,
    state: {
      players: room.players,
      clouds: room.clouds,
      items: room.items || [],
      roundStartedAt: room.roundStartedAt ?? null,
      itName: room.itName ?? null,
      winners: room.winners || [],
      createdAt: room.createdAt
    },
    // upsert doesn't auto-bump this on its own (no DB trigger exists) - set it explicitly on
    // every write so staleness checks (e.g. hiding long-finished rooms) have something real to
    // compare against.
    updated_at: new Date().toISOString()
  }
}

// Same external shape as the old localStorage/BroadcastChannel version ([rooms, updateRooms],
// where updateRooms takes the FULL desired array) - callers throughout App.jsx don't change.
// Internally, updateRooms diffs against the last-known array and upserts/deletes only what
// actually changed, since every real caller only ever adds/changes/removes one room at a time.
export function useRoomSync() {
  const [rooms, setRoomsState] = useState([])
  const roomsRef = useRef(rooms)
  roomsRef.current = rooms

  useEffect(() => {
    if (!isSupabaseConfigured) return
    let cancelled = false

    // Initial snapshot only - after this, every change is applied incrementally from the realtime
    // payload itself (see the channel subscription below), never by re-querying. Re-querying on
    // every change (the old approach) blindly REPLACED the entire local rooms array with whatever
    // that SELECT happened to return - if that read raced ahead of a just-written row's visibility
    // (a real possibility: e.g. a second player's own join event triggering a reload before the
    // room they're joining is guaranteed consistent in that particular read), a room that had just
    // been created, with zero errors anywhere, would silently vanish from every client's screen a
    // few seconds later. Confirmed live as the cause of "I create a room and it disappears" /
    // "kicked back to the setup screen every ~3s" reports. Applying the payload directly (same
    // shape as INSERT/UPDATE/DELETE) is both race-free (no re-read to race against) and cheaper (no
    // full-table re-fetch on every single change anywhere in the app).
    supabase
      .from('rooms')
      .select('*')
      .neq('status', 'closed')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.error('Failed to load rooms:', error.message)
          return
        }
        setRoomsState((data || []).map(rowToRoom))
      })

    const channel = supabase
      .channel('rooms-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (payload) => {
        if (cancelled) return
        setRoomsState((prev) => {
          if (payload.eventType === 'DELETE') {
            const deletedCode = payload.old?.code
            return deletedCode ? prev.filter((r) => r.code !== deletedCode) : prev
          }
          if (payload.new?.status === 'closed') {
            return prev.filter((r) => r.code !== payload.new.code)
          }
          const nextRoom = rowToRoom(payload.new)
          const idx = prev.findIndex((r) => r.code === nextRoom.code)
          if (idx === -1) return [...prev, nextRoom]
          const copy = prev.slice()
          copy[idx] = nextRoom
          return copy
        })
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [])

  // Only ever upserts, never deletes-by-diffing - confirmed via a live 2-client race test that
  // the old "delete anything in my own last-known list that's missing from what I'm about to
  // write" approach could genuinely destroy a room outright (not just lose a player update): any
  // client whose own local `rooms` happened to be even slightly behind (a brand-new tab whose
  // initial load/subscribe hadn't fully caught up yet, for instance) would treat that gap as "this
  // room was removed" and delete it from Supabase for everyone, real players included. Deletion is
  // now only ever explicit (see deleteRoom below), called with the one specific code a caller
  // actually intends to remove - never inferred from what's absent in a possibly-incomplete list.
  const updateRooms = useCallback((nextRooms) => {
    const prevByCode = new Map(roomsRef.current.map((r) => [r.code, r]))

    if (isSupabaseConfigured) {
      for (const room of nextRooms) {
        const prev = prevByCode.get(room.code)
        if (!prev || JSON.stringify(prev) !== JSON.stringify(room)) {
          supabase
            .from('rooms')
            .upsert(roomToRow(room))
            .then(({ error }) => {
              if (error) console.error('Failed to save room:', error.message)
            })
        }
      }
    }

    // Optimistic local update - the postgres_changes subscription above will reconcile shortly
    // after, but applying it immediately keeps the UI responsive instead of waiting a round trip.
    // roomsRef is updated synchronously right here too, not just via the top-of-render line above
    // - callers that need to read-after-write within the same tick (e.g. App.jsx's updateRoom,
    // called from the animation-frame movement loop, well outside React's normal render cycle)
    // would otherwise see a stale value until React actually gets around to re-rendering.
    roomsRef.current = nextRooms
    setRoomsState(nextRooms)
  }, [])

  const deleteRoom = useCallback((code) => {
    if (isSupabaseConfigured) {
      supabase
        .from('rooms')
        .delete()
        .eq('code', code)
        .then(({ error }) => {
          if (error) console.error('Failed to remove room:', error.message)
        })
    }
    const nextRooms = roomsRef.current.filter((room) => room.code !== code)
    roomsRef.current = nextRooms
    setRoomsState(nextRooms)
  }, [])

  return [rooms, updateRooms, roomsRef, deleteRoom]
}
