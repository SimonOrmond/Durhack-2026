import { Api, getUser, setUser } from "./api.js";

const $ = (id) => document.getElementById(id);
const homeFor = (user) => (user.role === "physio" ? "/physio.html" : "/index.html");

// Already signed in? Go straight through.
const existing = getUser();
if (existing) location.replace(homeFor(existing));

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
    const useNext = next && next !== "/login.html" && !(user.role === "physio" && next === "/index.html") && !(user.role === "patient" && next === "/physio.html");
    location.href = useNext ? next : homeFor(user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
