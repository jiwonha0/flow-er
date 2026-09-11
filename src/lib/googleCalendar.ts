export type GoogleCalendarEvent = {
  id: string;
  title: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: unknown) => void;
          }) => GoogleTokenClient;
        };
      };
    };
  }
}

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let scriptPromise: Promise<void> | null = null;

const requireBrowser = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Google Calendar 연동은 현재 웹 버전에서만 사용할 수 있어요.');
  }
};

const loadGoogleIdentityServices = async () => {
  requireBrowser();

  if (window.google?.accounts?.oauth2) return;
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Google 로그인 스크립트를 불러오지 못했어요.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google 로그인 스크립트를 불러오지 못했어요.'));
    document.head.appendChild(script);
  });

  return scriptPromise;
};

export const requestGoogleCalendarAccessToken = async (clientId: string): Promise<string> => {
  if (!clientId) {
    throw new Error('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID가 설정되지 않았어요.');
  }

  await loadGoogleIdentityServices();

  return new Promise<string>((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error('Google OAuth를 초기화하지 못했어요.'));
      return;
    }

    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: CALENDAR_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google 로그인이 취소되었어요.'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: () => reject(new Error('Google 로그인 창을 열지 못했어요.')),
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
};

export const fetchUpcomingGoogleCalendarEvents = async (
  accessToken: string,
  maxResults = 10,
): Promise<GoogleCalendarEvent[]> => {
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Calendar 일정을 불러오지 못했어요. (${response.status}) ${detail}`);
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items
    .filter((event: any) => event?.start?.dateTime || event?.start?.date)
    .map((event: any) => ({
      id: String(event.id),
      title: event.summary || '제목 없는 일정',
      location: event.location || '',
      start: event.start.dateTime || event.start.date,
      end: event.end?.dateTime || event.end?.date || event.start.dateTime || event.start.date,
      allDay: Boolean(event.start.date && !event.start.dateTime),
    }));
};

export const loadUpcomingGoogleCalendarEvents = async (
  clientId: string,
  maxResults = 10,
): Promise<GoogleCalendarEvent[]> => {
  const accessToken = await requestGoogleCalendarAccessToken(clientId);
  return fetchUpcomingGoogleCalendarEvents(accessToken, maxResults);
};
