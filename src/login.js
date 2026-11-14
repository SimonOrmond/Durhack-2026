import { Api, getUser, setUser } from "./api.js";

const $ = (id) => document.getElementById(id);
const homeFor = (user) => (user.role === "physio" ? "/physio.html" : "/index.html");

const params = new URLSearchParams(location.search);

// ?fresh=1 (used by the link in prescription emails): always show the login form, signing out
// whoever is signed in on this browser, so the patient can log in even if a physio was signed in.
if (params.get("fresh")) {
  setUser(null);
  history.replaceState(null, "", location.pathname + (params.get("next") ? `?next=${encodeURIComponent(params.get("next"))}` : ""));
} else {
  // Already signed in? Go straight through.
  const existing = getUser();
  if (existing) location.replace(homeFor(existing));
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("submit");
  const err = $("error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const user = await Api.login($("username").value.trim(), $("password").value);
    setUser(user);
    const next = new URLSearchParams(location.search).get("next");
    // Honour ?next= unless it would send a physio to the patient page (or vice versa).
    // Compare the path only, so "/index.html#dashboard" counts as the patient page.
    const nextPath = next ? next.split(/[?#]/)[0] : "";
    const useNext =
      next &&
      next.startsWith("/") &&
      nextPath !== "/login.html" &&
      !(user.role === "physio" && (nextPath === "/index.html" || nextPath === "/")) &&
      !(user.role === "patient" && nextPath === "/physio.html");
    location.href = useNext ? next : homeFor(user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
