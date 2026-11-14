// Tiny client for the Express API + current-user storage.
const USER_KEY = "physio.user";

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}
export function setUser(u) {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}
export function logout() {
  setUser(null);
  location.href = "/login.html";
}
/** Redirect to login unless a user with one of the given roles is stored. Returns the user. */
export function requireUser(...roles) {
  const u = getUser();
  if (!u || (roles.length && !roles.includes(u.role))) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  return u;
}

export async function api(path, { method = "GET", body } = {}) {
  const user = getUser();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-user-id": user._id } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

export const Api = {
  login: (username, password) => api("/login", { method: "POST", body: { username, password } }),
  exercises: () => api("/exercises"),
  patients: (physioId) => api(`/physios/${physioId}/patients`),
  patient: (id) => api(`/patients/${id}`),
  prescriptions: (patientId, all = false) => api(`/patients/${patientId}/prescriptions${all ? "?all=1" : ""}`),
  createPrescription: (body) => api("/prescriptions", { method: "POST", body }),
  stopPrescription: (id) => api(`/prescriptions/${id}`, { method: "DELETE" }),
  saveSession: (body) => api("/sessions", { method: "POST", body }),
  sessions: (patientId, limit = 20) => api(`/patients/${patientId}/sessions?limit=${limit}`),
  session: (id) => api(`/sessions/${id}`),
  progress: (patientId, days = 30) => api(`/patients/${patientId}/progress?days=${days}`),
};
