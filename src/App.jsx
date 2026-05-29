import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEYS = {
  sessions: 'openhermes.sessions',
  activeSessionId: 'openhermes.activeSessionId',
  proxyUrl: 'openhermes.proxyUrl',
  proxyUrlSource: 'openhermes.proxyUrlSource',
  apiToken: 'openhermes.apiToken',
  apiSecret: 'openhermes.apiSecret',
};

const initialSessions = [
  {
    id: 'session-1',
    title: '판텍큐 플러스 종합감기약 정보',
    updatedAt: new Date().toISOString(),
    messages: [
      { id: 'seed-1', role: 'user', content: '어떤 약이야' },
      {
        id: 'seed-2',
        role: 'assistant',
        content:
          '사진 속 약 정보와 복용 주의사항을 요약해 드릴 수 있어요. 현재는 예시 화면이므로, 실제 Hermes 연결 후에는 이미지/텍스트 기반 답변이 동작합니다.',
      },
    ],
  },
  {
    id: 'session-2',
    title: 'MCP 연결 점검',
    updatedAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    messages: [{ id: 'seed-3', role: 'user', content: '로컬 MCP 브리지 확인해줘' }],
  },
];

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function newId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

function describeControlAction(action = {}) {
  const name = String(action.action || 'action');
  const app = action.app ? ` @ ${action.app}` : '';
  if (name === 'openUrl') return `${name}${app} ${action.url || ''}`.trim();
  if (name === 'clickText') return `${name}${app} "${action.text || ''}"`.trim();
  if (name === 'clickUi') return `${name}${app} "${action.target?.text || action.text || ''}"`.trim();
  if (name === 'runShell') return `${name}${app} ${action.command || ''}`.trim();
  if (name === 'waitFor') {
    const condition = action.condition?.type || action.condition?.app || action.condition?.text || '';
    return `${name} ${condition} ${Number(action.timeoutMs || action.sleepMs || 0)}ms`.trim();
  }
  if (name === 'type') return `${name}${app} "${action.text || ''}"`.trim();
  if (name === 'shortcut') return `${name}${app} ${action.shortcut?.key || action.key || ''}`.trim();
  if (name === 'verify') return `${name} ${action.type || action.verify || ''} ${action.command || action.text || ''}`.trim();
  if (name === 'repairPlan') return `${name} ${action.summary || ''}`.trim();
  return `${name}${app}`.trim();
}

function summarizeResultPayload(result) {
  if (!result) return '아직 실행한 프롬프트가 없습니다.';
  if (result.error) return String(result.error);
  if (result.summary) return `${String(result.summary)}를 내부적으로 실행했습니다.`;
  if (result.finalStatus) {
    const bits = [`status=${result.finalStatus}`];
    if (result.repairRounds) bits.push(`repairs=${result.repairRounds}`);
    if (result.failedStep?.step) bits.push(`failedStep=${result.failedStep.step}`);
    return `${bits.join(' · ')} 상태로 처리했습니다.`;
  }
  return '실행이 완료되었습니다.';
}

function getLatestComputerTrace(result) {
  if (!Array.isArray(result?.executionTrace) || result.executionTrace.length === 0) {
    return null;
  }
  return result.executionTrace[result.executionTrace.length - 1] || null;
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function normalizeProxyInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return normalizeBaseUrl(trimmed);
  }
  if (/^\/\//.test(trimmed)) {
    return normalizeBaseUrl(`https:${trimmed}`);
  }
  return normalizeBaseUrl(`https://${trimmed}`);
}

function isPublicBrowser() {
  if (typeof window === 'undefined') return false;
  return !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function isPrivateProxyUrl(value) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|::1)(:\d+)?(\/|$)/i.test(String(value || '').trim());
}

function getQueryProxyUrl() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return normalizeProxyInput(params.get('proxy') || '');
}

function looksLikeComputerUsePrompt(text) {
  const lower = String(text || '').toLowerCase();
  const hasAppIntent =
    /(?:열어|켜|실행|launch|open|focus|visit|방문|시작|클릭|누르|입력|타이핑|검색|엔터|enter|run|명령)/i.test(lower) ||
    lower.includes('app') ||
    lower.includes('어플') ||
    lower.includes('어플리케이션');
  const mentionsControlTargets =
    lower.includes('chrome') ||
    lower.includes('크롬') ||
    lower.includes('cursor') ||
    lower.includes('codex') ||
    lower.includes('zed') ||
    lower.includes('제드') ||
    lower.includes('system settings') ||
    lower.includes('설정') ||
    lower.includes('github') ||
    lower.includes('daum') ||
    lower.includes('naver') ||
    lower.includes('google') ||
    lower.includes('youtube') ||
    lower.includes('blog') ||
    lower.includes('블로그') ||
    lower.includes('terminal') ||
    lower.includes('cmd') ||
    lower.includes('zsh') ||
    lower.includes('url') ||
    /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|io|co\.kr|kr|dev))/i.test(lower) ||
    /^https?:\/\//i.test(lower);
  return hasAppIntent && mentionsControlTargets;
}

function textEncoder() {
  return new TextEncoder();
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getStoredAuthHeaders({ method = 'GET', pathname = '/', body = '' } = {}) {
  const token = localStorage.getItem(STORAGE_KEYS.apiToken) || '';
  const secret = localStorage.getItem(STORAGE_KEYS.apiSecret) || '';
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (secret) {
    const timestamp = `${Date.now()}`;
    headers['X-OH-Timestamp'] = timestamp;
    headers['X-OH-Signature'] = await hmacHex(secret, `${timestamp}\n${method.toUpperCase()}\n${pathname}\n${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return headers;
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function parseAssistantResponse(response, onChunk) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content || '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (block.startsWith('data:')) {
        const data = block.slice(5).trim();
        if (data === '[DONE]') {
          return fullText;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.message?.content || '';
          if (delta) {
            fullText += delta;
            onChunk(fullText);
          }
        } catch {
          const fallback = data.replace(/^"|"$/g, '');
          if (fallback) {
            fullText += fallback;
            onChunk(fullText);
          }
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim().startsWith('data:')) {
    const data = buffer.trim().slice(5).trim();
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        onChunk(fullText);
      }
    } catch {
      fullText += data;
      onChunk(fullText);
    }
  }

  return fullText;
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [controlRailOpen, setControlRailOpen] = useState(false);
  const [sessions, setSessions] = useState(() => loadJson(STORAGE_KEYS.sessions, initialSessions));
  const [activeSessionId, setActiveSessionId] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.activeSessionId) || initialSessions[0].id;
  });
  const [draft, setDraft] = useState('');
  const initialProxyUrl = getQueryProxyUrl();
  const [proxyDraft, setProxyDraft] = useState(() => {
    const configUrl = import.meta.env.VITE_PROXY_URL || window.__OPENHERMES_CONFIG__?.proxyUrl || '';
    if (initialProxyUrl) {
      return initialProxyUrl;
    }
    const storedUrl = localStorage.getItem(STORAGE_KEYS.proxyUrl) || '';
    const storedSource = localStorage.getItem(STORAGE_KEYS.proxyUrlSource) || '';
    if (isPublicBrowser()) {
      return storedSource === 'manual' && storedUrl ? storedUrl : '';
    }
    return normalizeBaseUrl(storedUrl || configUrl || 'http://127.0.0.1:8787');
  });
  const [proxyUrl, setProxyUrl] = useState(() => {
    const configUrl = import.meta.env.VITE_PROXY_URL || window.__OPENHERMES_CONFIG__?.proxyUrl || '';
    if (initialProxyUrl) {
      return initialProxyUrl;
    }
    if (isPublicBrowser()) {
      const storedUrl = localStorage.getItem(STORAGE_KEYS.proxyUrl) || '';
      const storedSource = localStorage.getItem(STORAGE_KEYS.proxyUrlSource) || '';
      return storedSource === 'manual' && storedUrl ? normalizeBaseUrl(storedUrl) : '';
    }
    const storedUrl = localStorage.getItem(STORAGE_KEYS.proxyUrl) || '';
    return normalizeBaseUrl(storedUrl || configUrl || 'http://127.0.0.1:8787');
  });
  const [apiToken, setApiToken] = useState(() => localStorage.getItem(STORAGE_KEYS.apiToken) || '');
  const [apiSecret, setApiSecret] = useState(() => localStorage.getItem(STORAGE_KEYS.apiSecret) || '');
  const [status, setStatus] = useState({ proxy: 'unknown', upstream: 'unknown' });
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [auditRecords, setAuditRecords] = useState([]);
  const [requestQueue, setRequestQueue] = useState([]);
  const [actionStatus, setActionStatus] = useState('준비됨');
  const [computerPrompt, setComputerPrompt] = useState('Chrome으로 daum.net 열어줘');
  const [computerResult, setComputerResult] = useState(null);
  const [computerSending, setComputerSending] = useState(false);
  const [sending, setSending] = useState(false);
  const [systemNote, setSystemNote] = useState(() => (
    isPublicBrowser()
      ? '공개 Pages에서는 공개 Proxy URL을 입력하세요.'
      : '로컬 Hermes 연결 대기 중'
  ));
  const endRef = useRef(null);
  const proxyInputRef = useRef(null);

  const activeSession = useMemo(() => {
    return sessions.find((item) => item.id === activeSessionId) || sessions[0];
  }, [activeSessionId, sessions]);

  async function apiRequest(pathname, { method = 'GET', body } = {}) {
    if (!proxyUrl) {
      throw new Error('프록시 URL을 먼저 적용해 주세요');
    }
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const bodyForAuth = method === 'GET' ? '' : (body === undefined ? '' : body);
    const headers = {
      'Content-Type': 'application/json',
      ...await getStoredAuthHeaders({ method, pathname, body: bodyForAuth }),
    };
    const response = await fetch(`${normalizeBaseUrl(proxyUrl)}${pathname}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : requestBody,
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  async function refreshPermissionStatus() {
    try {
      const payload = await apiRequest('/api/permissions/status');
      setPermissionStatus(payload);
      setActionStatus('권한 상태를 불러왔습니다');
      return payload;
    } catch (error) {
      setActionStatus(`권한 상태 조회 실패: ${error.message || String(error)}`);
      return null;
    }
  }

  async function refreshAudit() {
    try {
      const payload = await apiRequest('/api/audit?limit=25');
      setAuditRecords(payload.records || []);
      return payload.records || [];
    } catch {
      return [];
    }
  }

  async function refreshRequestQueue() {
    try {
      const payload = await apiRequest('/api/requests?limit=20');
      setRequestQueue(payload.requests || []);
      return payload.requests || [];
    } catch {
      return [];
    }
  }

  async function requestPermission(targetPermission = 'automation') {
    setActionStatus(`권한 요청: ${targetPermission}`);
    try {
      const payload = await apiRequest('/api/permissions/request', {
        method: 'POST',
        body: {
          targetPermission,
          openPanels: true,
          autoAttempt: true,
        },
      });
      setActionStatus(`권한 요청 완료: ${targetPermission}`);
      await refreshPermissionStatus();
      await refreshAudit();
      return payload;
    } catch (error) {
      setActionStatus(`권한 요청 실패: ${error.message || String(error)}`);
      return null;
    }
  }

  function applyProxyDraft() {
    const liveDraft = proxyInputRef.current?.value ?? proxyDraft;
    const next = normalizeProxyInput(liveDraft);
    if (!next) {
      setProxyDraft('');
      setProxyUrl('');
      localStorage.removeItem(STORAGE_KEYS.proxyUrl);
      localStorage.removeItem(STORAGE_KEYS.proxyUrlSource);
      setActionStatus('프록시를 해제했습니다');
      return;
    }

    try {
      new URL(next);
    } catch {
      setActionStatus('유효한 http(s) Proxy URL을 입력해 주세요');
      return;
    }

    localStorage.setItem(STORAGE_KEYS.proxyUrlSource, 'manual');
    localStorage.setItem(STORAGE_KEYS.proxyUrl, next);
    setProxyDraft(next);
    setProxyUrl(next);
    setActionStatus(`프록시 적용: ${next}`);
  }

  async function runAutomation(action, extra = {}) {
    setActionStatus(`실행 중: ${action} ${extra.app || ''}`.trim());
    try {
      const payload = await apiRequest('/api/automation/app', {
        method: 'POST',
        body: {
          action,
          ...extra,
        },
      });
      setActionStatus(`완료: ${action} ${extra.app || ''}`.trim());
      await refreshAudit();
      return payload;
    } catch (error) {
      setActionStatus(`실행 실패: ${error.message || String(error)}`);
      return null;
    }
  }

  async function submitComputerPrompt(event) {
    event?.preventDefault?.();
    const prompt = computerPrompt.trim();
    if (!prompt || computerSending) return;
    setComputerSending(true);
    setActionStatus(`computer use: ${prompt}`);
    try {
      const payload = await apiRequest('/api/control', {
        method: 'POST',
        body: {
          task: prompt,
          execute: true,
        },
      });
      setComputerResult(payload);
      setActionStatus(payload?.queued ? `대기: ${payload?.summary || prompt}` : `완료: ${payload?.summary || prompt}`);
      await refreshRequestQueue();
      await refreshAudit();
      return payload;
    } catch (error) {
      setComputerResult({ ok: false, error: error.message || String(error) });
      setActionStatus(`실행 실패: ${error.message || String(error)}`);
      return null;
    } finally {
      setComputerSending(false);
    }
  }

  useEffect(() => {
    saveJson(STORAGE_KEYS.sessions, sessions);
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    if (isPublicBrowser()) {
      const storedUrl = localStorage.getItem(STORAGE_KEYS.proxyUrl) || '';
      const storedSource = localStorage.getItem(STORAGE_KEYS.proxyUrlSource) || '';
      if (storedSource !== 'manual' || !storedUrl) {
        localStorage.removeItem(STORAGE_KEYS.proxyUrl);
        localStorage.removeItem(STORAGE_KEYS.proxyUrlSource);
        setProxyDraft('');
      }
    }
  }, []);

  useEffect(() => {
    if (!initialProxyUrl) return;
    if (isPublicBrowser()) {
      localStorage.setItem(STORAGE_KEYS.proxyUrlSource, 'manual');
      localStorage.setItem(STORAGE_KEYS.proxyUrl, initialProxyUrl);
    }
    setProxyDraft(initialProxyUrl);
    setProxyUrl(initialProxyUrl);
  }, [initialProxyUrl]);

  useEffect(() => {
    if (proxyUrl) {
      localStorage.setItem(STORAGE_KEYS.proxyUrl, proxyUrl);
    } else {
      localStorage.removeItem(STORAGE_KEYS.proxyUrl);
    }
  }, [proxyUrl]);
  
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.apiToken, apiToken);
  }, [apiToken]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.apiSecret, apiSecret);
  }, [apiSecret]);

  useEffect(() => {
    if (!proxyUrl) return;
    let cancelled = false;
    const pageIsPublic = isPublicBrowser();
    const storedSource = localStorage.getItem(STORAGE_KEYS.proxyUrlSource) || '';
    const proxyIsPrivate = isPrivateProxyUrl(proxyUrl);

    if (pageIsPublic && (storedSource !== 'manual' || proxyIsPrivate)) {
      if (proxyIsPrivate) {
        setProxyUrl('');
        localStorage.removeItem(STORAGE_KEYS.proxyUrl);
        localStorage.removeItem(STORAGE_KEYS.proxyUrlSource);
      }
      setStatus({ proxy: 'unknown', upstream: 'unknown' });
      setSystemNote('공개 Pages에서는 먼저 공개 Proxy URL을 입력하세요.');
      return () => {
        cancelled = true;
      };
    }

    async function loadHealth() {
      try {
        const response = await fetch(`${normalizeBaseUrl(proxyUrl)}/api/health`);
        const payload = await response.json();
        if (cancelled) return;
        setStatus({
          proxy: response.ok ? 'ready' : 'down',
          upstream: payload?.upstream?.ok ? 'ready' : 'down',
        });
        setSystemNote(
          payload?.upstream?.ok
            ? `Hermes ${payload.upstream.baseUrl} 연결됨`
            : 'Hermes 연결을 확인하는 중',
        );
      } catch {
        if (cancelled) return;
        setStatus({ proxy: 'down', upstream: 'down' });
        setSystemNote(pageIsPublic ? '공개 Proxy URL 연결 실패' : '프록시를 찾을 수 없습니다');
      }
    }

    loadHealth();
    const timer = setInterval(loadHealth, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [proxyUrl]);

  useEffect(() => {
    if (!proxyUrl) return;
    refreshPermissionStatus();
    refreshAudit();
    refreshRequestQueue();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyUrl, apiToken, apiSecret]);

  useEffect(() => {
    if (!proxyUrl) return undefined;
    const timer = setInterval(() => {
      refreshRequestQueue();
    }, 15000);
    return () => clearInterval(timer);
  }, [proxyUrl, apiToken, apiSecret]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [sessions, activeSessionId]);

  function updateActiveSession(mutator) {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== activeSessionId) return session;
        return mutator(session);
      }),
    );
  }

  function createSession() {
    const id = newId('session');
    const session = {
      id,
      title: '새 채팅',
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    setSessions((current) => [session, ...current]);
    setActiveSessionId(id);
    setSidebarOpen(false);
  }

  async function submitMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || !activeSession) return;

    const userMessage = { id: newId('msg'), role: 'user', content: text };
    const assistantId = newId('msg');
    setDraft('');
    setSending(true);

    updateActiveSession((session) => ({
      ...session,
      title: session.messages.length === 0 ? text.slice(0, 32) : session.title,
      updatedAt: new Date().toISOString(),
      messages: [
        ...session.messages,
        userMessage,
        { id: assistantId, role: 'assistant', content: '...' },
      ],
    }));

    try {
      if (looksLikeComputerUsePrompt(text)) {
        const response = await apiRequest('/api/control', {
          method: 'POST',
          body: {
            task: text,
            execute: true,
          },
        });
        const summary = response?.summary || '컴퓨터 제어를 실행했습니다.';
        const content = response?.queued
          ? `${summary}\n\n실행 대기 중입니다.\nrequestId: ${response?.request?.id || response?.requestId || 'unknown'}\n${JSON.stringify(response?.request || response, null, 2)}`
          : `${summary}\n\n${JSON.stringify({
              plan: response?.plan,
              finalStatus: response?.finalStatus,
              failedStep: response?.failedStep,
              executionTrace: response?.executionTrace,
            }, null, 2)}`;
        updateActiveSession((session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: session.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content,
                }
              : message,
          ),
        }));
        setActionStatus(response?.queued ? `대기: ${summary}` : `컴퓨터 제어 완료: ${summary}`);
        await refreshRequestQueue();
        await refreshAudit();
        setSending(false);
        return;
      }

      const requestBody = {
        messages: [...activeSession.messages, userMessage].map((message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: true,
      };
      const authHeaders = await getStoredAuthHeaders({
        method: 'POST',
        pathname: '/api/chat',
        body: requestBody,
      });
      const response = await fetch(`${normalizeBaseUrl(proxyUrl)}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const fallback = await response.text();
        throw new Error(fallback || `HTTP ${response.status}`);
      }

      let transcript = '';
      transcript = await parseAssistantResponse(response, (next) => {
        updateActiveSession((session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: session.messages.map((message) =>
            message.id === assistantId ? { ...message, content: next } : message,
          ),
        }));
      });

      updateActiveSession((session) => ({
        ...session,
        updatedAt: new Date().toISOString(),
        messages: session.messages.map((message) =>
          message.id === assistantId ? { ...message, content: transcript || '응답이 비어 있습니다.' } : message,
        ),
      }));
    } catch (error) {
      updateActiveSession((session) => ({
        ...session,
        updatedAt: new Date().toISOString(),
        messages: session.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: `연결 실패: ${error.message || String(error)}`,
              }
            : message,
        ),
      }));
    } finally {
      setSending(false);
    }
  }

  const recentSessions = sessions.slice(0, 10);

  return (
    <div className="shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brandRow">
          <div className="brandMark" aria-hidden="true" />
          <div>
            <div className="brandName">OpenHermes</div>
            <div className="brandSub">Local control cockpit</div>
          </div>
          <button className="ghostIcon desktopOnly" type="button" onClick={() => setSidebarOpen(false)} aria-label="사이드바 접기">
            <span>◫</span>
          </button>
        </div>

        <nav className="navBlock">
          <button className="navPrimary" type="button" onClick={createSession}>
            <span>+</span>
            <span>새 채팅</span>
          </button>
          <button className="navItem" type="button">
            <span>⌕</span>
            <span>채팅 검색</span>
          </button>
          <button className="navItem" type="button">
            <span>◌</span>
            <span>라이브러리</span>
          </button>
        </nav>

        <div className="sectionLabel">노트북</div>
        <div className="cardList">
          <button className="navItem" type="button">
            <span>⌂</span>
            <span>0원 창업</span>
          </button>
          <button className="navItem" type="button">
            <span>⌁</span>
            <span>n8n과 Make: AI 자동화 선택 가이드</span>
          </button>
          <button className="navItem" type="button">
            <span>⋯</span>
            <span>모든 노트북</span>
          </button>
        </div>

        <div className="sectionLabel">최근</div>
        <div className="recentList">
          {recentSessions.map((session) => (
            <button
              key={session.id}
              className={`recentItem ${session.id === activeSessionId ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setActiveSessionId(session.id);
                setSidebarOpen(false);
              }}
            >
              <span className="recentTitle">{session.title}</span>
              <span className="recentTime">{formatTime(session.updatedAt)}</span>
            </button>
          ))}
        </div>

        <div className="sidebarFooter">
          <div className="userChip">
            <div className="userAvatar">m</div>
            <div>
              <div className="userName">minsu lee</div>
              <div className="userMeta">Tailscale ready</div>
            </div>
          </div>
          <button className="ghostIcon" type="button" aria-label="설정">
            <span>⚙</span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="ghostIcon mobileOnly" type="button" onClick={() => setSidebarOpen(true)} aria-label="메뉴 열기">
            <span>≡</span>
          </button>
          <div className="topbarMeta">
            <div className="topline">Hermes local agent</div>
            <div className="headline">맥북 제어 · MCP 브리지 · GitHub Pages</div>
          </div>
          <div className="statusGroup">
            <span className={`statusPill ${status.proxy}`}>Proxy {status.proxy}</span>
            <span className={`statusPill ${status.upstream}`}>Hermes {status.upstream}</span>
            <button className="statusAction" type="button" onClick={refreshPermissionStatus}>
              권한 새로고침
            </button>
            <button
              className={`statusAction ${controlRailOpen ? 'active' : ''}`}
              type="button"
              onClick={() => setControlRailOpen((current) => !current)}
              aria-pressed={controlRailOpen}
            >
              {controlRailOpen ? '제어창 닫기' : '제어창 열기'}
            </button>
          </div>
        </header>

        <section className="hero">
          <div className="heroCopy">
            <p className="eyebrow">OpenHermes / local first</p>
            <h1>로컬 Hermes를 웹, CLI, MCP, Tailscale, Pages, 그리고 macOS 전영역 제어로 이어 붙입니다.</h1>
            <p className="lede">
              이 화면은 Gemini 스타일 레이아웃을 기준으로 만든 반응형 채팅 UI입니다. 권한 센터에서 Automation / Accessibility / Screen Recording 상태를 확인하고, System Settings와 Chrome, Cursor, Codex를 바로 실행할 수 있습니다.
            </p>
            <div className="chipRow">
              <span className="chip">Web UI</span>
              <span className="chip">CLI</span>
              <span className="chip">MCP</span>
              <span className="chip">Computer Use</span>
            </div>
          </div>

          <div className="heroRail">
            <div className="upgradeCard">
              <div className="upgradePill">Permission Center</div>
              <div className="upgradeVisual" />
            </div>
            <div className="noteBubble">
              <span className="noteText">{systemNote}</span>
            </div>
          </div>
        </section>

        <section className={`contentGrid ${controlRailOpen ? 'withRail' : 'chatOnly'}`}>
          <section className="conversationShell">
            <div className="messages">
              {(activeSession?.messages || []).map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="messageAvatar">{message.role === 'user' ? 'U' : 'H'}</div>
                  <div className="messageBody">
                    <div className="messageLabel">{message.role === 'user' ? 'You' : 'Hermes'}</div>
                    <div className="messageText">{message.content}</div>
                  </div>
                </article>
              ))}
              {!activeSession?.messages?.length && (
                <div className="emptyState">
                  <div className="emptyMark" />
                  <h2>질문을 입력하면 로컬 Hermes로 전달됩니다.</h2>
                  <p>권한 요청 버튼을 누르면 System Settings가 열리고, 자동화/접근성/화면 기록 상태를 바로 점검할 수 있습니다.</p>
                </div>
              )}
              <div ref={endRef} />
            </div>

            <form className="composer" onSubmit={submitMessage}>
              <button className="composeIcon" type="button" onClick={createSession} aria-label="새 세션">
                +
              </button>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="OpenHermes에게 물어보기"
                autoComplete="off"
                spellCheck="false"
              />
              <button className="sendButton" type="submit" disabled={sending || !draft.trim()}>
                {sending ? '...' : 'Send'}
              </button>
            </form>
            <div className="composerHint">
              기본 프록시: {proxyUrl || '설정 필요'} · {actionStatus}
            </div>
          </section>

          {controlRailOpen && (
            <aside className="controlRail">
              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                    <div className="sectionLabel">최근 요청</div>
                    <h3>외부 요청 실행 기록</h3>
                  </div>
                  <button className="ghostButton" type="button" onClick={refreshRequestQueue}>
                    새로고침
                  </button>
                </div>
                <div className="queueList">
                  {requestQueue.length ? requestQueue.map((request) => {
                    const statusClass = String(request.status || 'executed').toLowerCase();
                    return (
                      <article key={request.id} className="queueItem">
                        <div className="queueTop">
                          <div className="queueMeta">
                            <span className={`queueBadge ${statusClass}`}>{request.status || 'executed'}</span>
                            <span className="queueSource">{request.sourceLabel || request.source || 'request'}</span>
                          </div>
                          <span className="queueTime">{formatTime(request.updatedAt || request.createdAt)}</span>
                        </div>
                        <div className="queueTitle">{request.summary || request.task || request.id}</div>
                        <div className="queueSub">
                          {request.requestId || request.id}
                          {request.plan?.actions?.length ? ` · ${request.plan.actions.length} actions` : ''}
                          {request.executionSummary ? ` · ${request.executionSummary}` : ''}
                          {request.finalStatus ? ` · ${request.finalStatus}` : ''}
                        </div>
                      </article>
                    );
                  }) : (
                    <div className="emptyAudit">최근 요청이 없습니다.</div>
                  )}
                </div>
              </section>

              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                    <div className="sectionLabel">Computer Use</div>
                    <h3>실제 프롬프트로 macOS 제어</h3>
                  </div>
                  <button className="ghostButton" type="button" onClick={() => setControlRailOpen(false)}>
                    닫기
                  </button>
                </div>
                <form className="computerForm" onSubmit={submitComputerPrompt}>
                  <label className="fieldLabel">
                    Prompt
                    <textarea
                      value={computerPrompt}
                      onChange={(event) => setComputerPrompt(event.target.value)}
                      placeholder="예: Chrome으로 daum.net 열어줘"
                      rows={3}
                    />
                  </label>
                  <div className="buttonGrid">
                    <button type="submit" className="railButton" disabled={computerSending}>
                      {computerSending ? '실행 중...' : '실행'}
                    </button>
                  <button type="button" className="railButton" onClick={() => setComputerPrompt('Chrome으로 daum.net 열어줘')}>
                    Daum 예시
                  </button>
                  <button type="button" className="railButton" onClick={() => setComputerPrompt('크롬으로 네이버 메인 창을켜셔, 마우스로 블로그 버튼을 클릭해.')}>
                    Naver 블로그
                  </button>
                  <button type="button" className="railButton" onClick={() => setComputerPrompt('Zed에서, "printing-landing — zsh" 적힌 cmd 창에서, 현재 폴더 리스트를 조회하는 명령어를 실행')}>
                    Zed 터미널
                  </button>
                  <button type="button" className="railButton" onClick={() => setComputerPrompt('Cursor를 열어줘')}>
                    Cursor 예시
                  </button>
                    <button type="button" className="railButton" onClick={() => setComputerPrompt('시스템 Automation 권한 창을 열어줘')}>
                      권한 창
                    </button>
                  </div>
                </form>
                <div className="actionCard">
                  <div className="actionTitle">실행 결과</div>
                  <div className="messageThread">
                    <div className="messageBubble userBubble">
                      <div className="messageLabel">Prompt</div>
                      <div className="messageText">{computerPrompt || '프롬프트 없음'}</div>
                    </div>
                    <div className="messageBubble assistantBubble">
                      <div className="messageLabel">Result</div>
                      <div className="messageText">{summarizeResultPayload(computerResult)}</div>
                      <div className="messageMeta">
                        {computerResult?.finalStatus ? `status=${computerResult.finalStatus}` : ''}
                        {computerResult?.repairRounds ? ` · repairs=${computerResult.repairRounds}` : ''}
                        {computerResult?.failedStep?.step ? ` · failedStep=${computerResult.failedStep.step}` : ''}
                      </div>
                    </div>
                  </div>
                  {computerResult?.finalStatus && (
                    <div className="actionMeta">
                      status: {computerResult.finalStatus}
                      {computerResult.repairRounds ? ` · repairs ${computerResult.repairRounds}` : ''}
                      {computerResult.failedStep ? ` · failed step ${computerResult.failedStep.step}` : ''}
                    </div>
                  )}
                  {getLatestComputerTrace(computerResult)?.result?.screenshot?.dataUrl && (
                    <div className="capturePreview">
                      <div className="actionMeta">
                        capture: visible · {getLatestComputerTrace(computerResult)?.result?.screenshot?.path?.split('/').pop() || 'screen.png'}
                      </div>
                      <img
                        className="captureImage"
                        src={getLatestComputerTrace(computerResult).result.screenshot.dataUrl}
                        alt="computer use capture preview"
                      />
                    </div>
                  )}
                  {Array.isArray(computerResult?.executionTrace) && computerResult.executionTrace.length > 0 && (
                    <div className="traceList">
                      {computerResult.executionTrace.map((entry) => (
                        <div key={`${entry.step}-${describeControlAction(entry.action)}`} className={`traceItem ${entry.ok ? 'ok' : 'fail'}`}>
                          <div className="traceTop">
                            <span>Step {entry.step}</span>
                            <span>{entry.ok ? 'ok' : 'fail'}</span>
                          </div>
                          <div className="traceAction">{describeControlAction(entry.action)}</div>
                          <div className="traceMeta">
                            {entry.strategyUsed ? `strategy=${entry.strategyUsed}` : ''}
                            {entry.fallbackUsed ? ` · fallback=${entry.fallbackUsed}` : ''}
                            {Number.isFinite(entry.elapsedMs) ? ` · ${entry.elapsedMs}ms` : ''}
                            {entry.result?.observedText ? ` · ocr="${String(entry.result.observedText).slice(0, 80)}"` : ''}
                            {entry.result?.screenshot?.path ? ` · shot=${entry.result.screenshot.path.split('/').pop()}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                    <div className="sectionLabel">권한 센터</div>
                    <h3>macOS 컴퓨터 사용 권한</h3>
                  </div>
                  <button className="ghostButton" type="button" onClick={refreshPermissionStatus}>
                    새로고침
                  </button>
                </div>
                <div className="permissionGrid">
                  <div className="permissionItem">
                    <span className="permissionKey">Automation</span>
                    <span className={`permissionValue ${permissionStatus?.automation?.state || 'unknown'}`}>{permissionStatus?.automation?.state || 'unknown'}</span>
                  </div>
                  <div className="permissionItem">
                    <span className="permissionKey">Accessibility</span>
                    <span className={`permissionValue ${permissionStatus?.accessibility?.state || 'unknown'}`}>{permissionStatus?.accessibility?.state || 'unknown'}</span>
                  </div>
                  <div className="permissionItem">
                    <span className="permissionKey">Screen</span>
                    <span className={`permissionValue ${permissionStatus?.screenRecording?.state || 'unknown'}`}>{permissionStatus?.screenRecording?.state || 'unknown'}</span>
                  </div>
                  <div className="permissionItem">
                    <span className="permissionKey">Files</span>
                    <span className={`permissionValue ${permissionStatus?.filesAndFolders?.state || 'unknown'}`}>{permissionStatus?.filesAndFolders?.state || 'unknown'}</span>
                  </div>
                </div>
                <div className="buttonGrid">
                  <button type="button" className="railButton" onClick={() => requestPermission('automation')}>Automation 요청</button>
                  <button type="button" className="railButton" onClick={() => requestPermission('accessibility')}>Accessibility 요청</button>
                  <button type="button" className="railButton" onClick={() => requestPermission('screenrecording')}>Screen 요청</button>
                  <button type="button" className="railButton" onClick={() => requestPermission('filesandfolders')}>Files 요청</button>
                </div>
                <div className="miniList">
                  <div className="miniRow">
                    <span>Automation</span>
                    <span>{permissionStatus?.automation?.details || 'probe pending'}</span>
                  </div>
                  <div className="miniRow">
                    <span>Accessibility</span>
                    <span>{permissionStatus?.accessibility?.details || 'probe pending'}</span>
                  </div>
                  <div className="miniRow">
                    <span>Screen</span>
                    <span>{permissionStatus?.screenRecording?.details || 'probe pending'}</span>
                  </div>
                </div>
              </section>

              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                    <div className="sectionLabel">앱 제어</div>
                    <h3>Chrome · Cursor · Codex · System Settings</h3>
                  </div>
                </div>
                <div className="buttonGrid">
                  <button type="button" className="railButton" onClick={() => runAutomation('launch', { app: 'Google Chrome' })}>Chrome launch</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('focus', { app: 'Google Chrome' })}>Chrome focus</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('openUrl', { app: 'Google Chrome', url: 'https://www.google.com' })}>Chrome open URL</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('launch', { app: 'Cursor' })}>Cursor launch</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('focus', { app: 'Cursor' })}>Cursor focus</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('launch', { app: 'Codex' })}>Codex launch</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('focus', { app: 'Codex' })}>Codex focus</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('openSystemPane', { pane: 'automation' })}>System Automation</button>
                  <button type="button" className="railButton" onClick={() => runAutomation('openSystemPane', { pane: 'accessibility' })}>System Accessibility</button>
                </div>
                <div className="actionCard">
                  <div className="actionTitle">빠른 실행</div>
                  <div className="actionDesc">브라우저, 시스템 설정, 앱 포커스 전환을 버튼으로 실행합니다.</div>
                </div>
              </section>

              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                    <div className="sectionLabel">감사 로그</div>
                    <h3>최근 제어 기록</h3>
                  </div>
                  <button className="ghostButton" type="button" onClick={refreshAudit}>새로고침</button>
                </div>
                <div className="auditList">
                  {auditRecords.length ? auditRecords.map((record, index) => (
                    <div key={`${record.ts || 'audit'}-${index}`} className="auditItem">
                      <div className="auditTop">
                        <span>{record.event || 'event'}</span>
                        <span>{formatTime(record.ts || new Date().toISOString())}</span>
                      </div>
                      <div className="auditBody">{record.error || record.reason || record.path || record.method || 'ok'}</div>
                    </div>
                  )) : (
                    <div className="emptyAudit">아직 감사 로그가 없습니다.</div>
                  )}
                </div>
              </section>

              <section className="railCard railCardCompact">
                <div className="railHeader">
                  <div>
                <div className="sectionLabel">연결 설정</div>
                <h3>프록시 / 서명</h3>
              </div>
            </div>
            <label className="fieldLabel">
              Proxy URL
              <input
                ref={proxyInputRef}
                value={proxyDraft}
                onChange={(event) => setProxyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyProxyDraft();
                  }
                }}
                placeholder={isPublicBrowser() ? 'https://<public proxy url>' : 'http://127.0.0.1:8787'}
              />
            </label>
            <div className="queueActions">
              <button type="button" className="ghostButton" onClick={applyProxyDraft}>
                적용
              </button>
              <button
                type="button"
                className="ghostButton"
                onClick={() => {
                  setProxyDraft('');
                  setProxyUrl('');
                  localStorage.removeItem(STORAGE_KEYS.proxyUrl);
                  localStorage.removeItem(STORAGE_KEYS.proxyUrlSource);
                  setActionStatus('프록시 입력을 지웠습니다');
                }}
              >
                비우기
              </button>
            </div>
            <div className="actionCard">
              <div className="actionTitle">현재 적용됨</div>
              <div className="actionDesc">{proxyUrl || '아직 적용된 Proxy URL이 없습니다.'}</div>
            </div>
            <label className="fieldLabel">
              API Token
              <input value={apiToken} onChange={(event) => setApiToken(event.target.value)} placeholder="선택" />
            </label>
            <label className="fieldLabel">
              API Secret
              <input value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} placeholder="선택" />
            </label>
            {isPublicBrowser() && (
              <div className="actionCard">
                <div className="actionTitle">공개 Pages 모드</div>
                <div className="actionDesc">
                  자동 상태 조회는 끄고, 여기에 입력한 공개 Proxy URL만 사용합니다.
                </div>
              </div>
            )}
          </section>
        </aside>
      )}
        </section>
      </main>
    </div>
  );
}
