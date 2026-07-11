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

    const load = () => {
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
    }
    load()

    const channel = supabase
      .channel('rooms-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, load)
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [])

  const updateRooms = useCallback((nextRooms) => {
    const prevByCode = new Map(roomsRef.current.map((r) => [r.code, r]))
    const nextByCode = new Map(nextRooms.map((r) => [r.code, r]))

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
      for (const room of roomsRef.current) {
        if (!nextByCode.has(room.code)) {
          supabase
            .from('rooms')
            .delete()
            .eq('code', room.code)
            .then(({ error }) => {
              if (error) console.error('Failed to remove room:', error.message)
            })
        }
      }
    }

    // Optimistic local update - the postgres_changes subscription above will reconcile shortly
    // after, but applying it immediately keeps the UI responsive instead of waiting a round trip.
    setRoomsState(nextRooms)
  }, [])

  return [rooms, updateRooms]
}
