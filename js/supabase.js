/* ============================================================
   supabase.js — Cloud Database & Authentication
   
   RESPONSIBILITIES:
   - Connect to Supabase (PostgreSQL cloud database)
   - Handle user registration and login
   - Save/load trades per user from cloud
   - Save/load notes per user from cloud
   - Save/load settings per user from cloud
   - Keep localStorage as offline cache
   - Sync on login and after every change

   HOW IT WORKS:
   1. User registers/logs in → Supabase gives them a session
   2. All trades saved to cloud under their user ID
   3. Each user only sees their own data (Row Level Security)
   4. localStorage used as fast local cache
   ============================================================ */

const SUPABASE_URL    = 'https://nkdgthaerzxahjxrzpcl.supabase.co';
const SUPABASE_ANON   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rZGd0aGFlcnp4YWhqeHJ6cGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDY0NjUsImV4cCI6MjA5NjE4MjQ2NX0.O0cF0LzqJh2vEbBUaRsCqXg0oxSasSJpFFimKTP5cJA';

/* ============================================================
   SupabaseClient — Low-level HTTP wrapper for Supabase REST API
   Handles all API calls: auth, select, insert, update, delete
   ============================================================ */
const SupabaseClient = (() => {

  let _session = null; // current user session token

  // ── Set session after login ───────────────────────────────
  function setSession(session) { _session = session; }
  function getSession()        { return _session; }
  function getUserId()         { return _session?.user?.id || null; }
  function getUserEmail()      { return _session?.user?.email || null; }

  // ── Build request headers ─────────────────────────────────
  function headers(extra = {}) {
    const h = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON,
      'Authorization': `Bearer ${_session?.access_token || SUPABASE_ANON}`
    };
    return { ...h, ...extra };
  }

  // ── Generic REST call ─────────────────────────────────────
  async function rest(method, path, body = null, params = '') {
    const url  = `${SUPABASE_URL}/rest/v1/${path}${params}`;
    const opts = { method, headers: headers() };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── AUTH: Register new user ───────────────────────────────
  async function signUp(email, password, fullName) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        email, password,
        data: { full_name: fullName }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Registration failed');
    return data;
  }

  // ── AUTH: Login ───────────────────────────────────────────
  async function signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Login failed');
    _session = data;
    return data;
  }

  // ── AUTH: Logout ──────────────────────────────────────────
  async function signOut() {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: headers()
    }).catch(() => {});
    _session = null;
  }

  // ── AUTH: Restore session from localStorage ───────────────
  async function restoreSession() {
    try {
      const saved = localStorage.getItem('kf_session');
      if (!saved) return null;
      const session = JSON.parse(saved);
      // Check if token is still valid (not expired)
      const exp = session?.expires_at || 0;
      if (Date.now() / 1000 > exp - 60) {
        // Try to refresh
        const refreshed = await refreshSession(session.refresh_token);
        if (refreshed) return refreshed;
        localStorage.removeItem('kf_session');
        return null;
      }
      _session = session;
      return session;
    } catch (e) { return null; }
  }

  // ── AUTH: Refresh expired token ───────────────────────────
  async function refreshSession(refreshToken) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      const data = await res.json();
      if (!res.ok) return null;
      _session = data;
      localStorage.setItem('kf_session', JSON.stringify(data));
      return data;
    } catch (e) { return null; }
  }

  // ── DATABASE: Select rows ─────────────────────────────────
  async function select(table, filter = '') {
    return rest('GET', table, null,
      `?select=*${filter}&order=created_at.desc`);
  }

  // ── DATABASE: Insert row ──────────────────────────────────
  async function insert(table, data) {
    return rest('POST', table, data,
      '?select=*');
  }

  // ── DATABASE: Update row ──────────────────────────────────
  async function update(table, id, data) {
    return rest('PATCH', table, data,
      `?id=eq.${id}&select=*`);
  }

  // ── DATABASE: Delete row ──────────────────────────────────
  async function remove(table, id) {
    return rest('DELETE', table, null,
      `?id=eq.${id}`);
  }

  // ── DATABASE: Upsert (insert or update) ───────────────────
  async function upsert(table, data) {
    return rest('POST', table, data,
      '?on_conflict=id&select=*',
    );
  }

  return {
    setSession, getSession, getUserId, getUserEmail,
    signUp, signIn, signOut, restoreSession,
    select, insert, update, remove, upsert
  };

})();

/* ============================================================
   CloudStore — High-level cloud data operations
   Wraps SupabaseClient with app-specific logic.
   Falls back to DataStore (localStorage) when offline.
   ============================================================ */
const CloudStore = (() => {

  let _online = false;

  function isOnline() { return _online && !!SupabaseClient.getUserId(); }

  // ── TRADES ────────────────────────────────────────────────

  // Load all trades for current user from cloud
  async function loadTrades() {
    if (!isOnline()) return null;
    try {
      const rows = await SupabaseClient.select('trades',
        `&user_id=eq.${SupabaseClient.getUserId()}`);
      return (rows || []).map(r => JSON.parse(r.data));
    } catch (e) {
      console.warn('CloudStore.loadTrades failed:', e.message);
      return null;
    }
  }

  // Save a single trade to cloud
  async function saveTrade(trade) {
    if (!isOnline()) return null;
    try {
      const row = {
        id:      trade.id,
        user_id: SupabaseClient.getUserId(),
        data:    JSON.stringify(trade),
        symbol:  trade.symbol,
        pnl:     trade.pnl || 0,
        entry_date: trade.entryDate
      };
      const res = await SupabaseClient.upsert('trades', row);
      return res;
    } catch (e) {
      console.warn('CloudStore.saveTrade failed:', e.message);
      return null;
    }
  }

  // Delete a trade from cloud
  async function deleteTrade(tradeId) {
    if (!isOnline()) return null;
    try {
      // Find the cloud row by trade id stored in data
      const rows = await SupabaseClient.select('trades',
        `&user_id=eq.${SupabaseClient.getUserId()}&id=eq.${tradeId}`);
      if (rows && rows.length > 0) {
        await SupabaseClient.remove('trades', rows[0].id);
      }
    } catch (e) {
      console.warn('CloudStore.deleteTrade failed:', e.message);
    }
  }

  // Sync all local trades to cloud (used on first login)
  async function syncLocalTrades(localTrades) {
    if (!isOnline()) return;
    try {
      for (const trade of localTrades) {
        await saveTrade(trade);
      }
    } catch (e) {
      console.warn('CloudStore.syncLocalTrades failed:', e.message);
    }
  }

  // ── NOTES ─────────────────────────────────────────────────

  async function loadNotes() {
    if (!isOnline()) return null;
    try {
      const rows = await SupabaseClient.select('notes',
        `&user_id=eq.${SupabaseClient.getUserId()}`);
      return (rows || []).map(r => JSON.parse(r.data));
    } catch (e) { return null; }
  }

  async function saveNote(note) {
    if (!isOnline()) return null;
    try {
      const row = {
        id:      note.id,
        user_id: SupabaseClient.getUserId(),
        data:    JSON.stringify(note)
      };
      return await SupabaseClient.upsert('notes', row);
    } catch (e) { return null; }
  }

  async function deleteNote(noteId) {
    if (!isOnline()) return null;
    try {
      const rows = await SupabaseClient.select('notes',
        `&user_id=eq.${SupabaseClient.getUserId()}&id=eq.${noteId}`);
      if (rows && rows.length > 0) {
        await SupabaseClient.remove('notes', rows[0].id);
      }
    } catch (e) {}
  }

  // ── SETTINGS ──────────────────────────────────────────────

  async function loadSettings() {
    if (!isOnline()) return null;
    try {
      const rows = await SupabaseClient.select('user_settings',
        `&user_id=eq.${SupabaseClient.getUserId()}`);
      if (rows && rows.length > 0) return JSON.parse(rows[0].data);
      return null;
    } catch (e) { return null; }
  }

  async function saveSettings(settings) {
    if (!isOnline()) return null;
    try {
      const uid = SupabaseClient.getUserId();
      // Check if settings row exists
      const rows = await SupabaseClient.select('user_settings',
        `&user_id=eq.${uid}`);
      if (rows && rows.length > 0) {
        await SupabaseClient.update('user_settings', rows[0].id,
          { data: JSON.stringify(settings) });
      } else {
        await SupabaseClient.insert('user_settings', {
          user_id: uid,
          data: JSON.stringify(settings)
        });
      }
    } catch (e) {}
  }

  // Delete ALL trades for the current user from cloud (used by Clear All)
  async function deleteAllTrades() {
    if (!isOnline()) return;
    try {
      const uid = SupabaseClient.getUserId();
      // Delete all rows where user_id matches — single REST call
      const url = `${SUPABASE_URL}/rest/v1/trades?user_id=eq.${uid}`;
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${SupabaseClient.getSession()?.access_token || SUPABASE_ANON}`
        }
      });
    } catch (e) {
      console.warn('CloudStore.deleteAllTrades failed:', e.message);
    }
  }

  // Delete ALL notes for the current user from cloud
  async function deleteAllNotes() {
    if (!isOnline()) return;
    try {
      const uid = SupabaseClient.getUserId();
      const url = `${SUPABASE_URL}/rest/v1/notes?user_id=eq.${uid}`;
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${SupabaseClient.getSession()?.access_token || SUPABASE_ANON}`
        }
      });
    } catch (e) {
      console.warn('CloudStore.deleteAllNotes failed:', e.message);
    }
  }

  function setOnline(val) { _online = val; }

  return {
    isOnline, setOnline,
    loadTrades, saveTrade, deleteTrade, deleteAllTrades, syncLocalTrades,
    loadNotes, saveNote, deleteNote, deleteAllNotes,
    loadSettings, saveSettings
  };

})();
