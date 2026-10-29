/** Tiny server-rendered pages for the desktop sign-in flow. No client JS needed. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{color-scheme:light dark;--bg:#0f1115;--card:#171a21;--fg:#e6e8ee;--muted:#9aa3b2;--accent:#6c8cff;--border:#2a2f3a;--danger:#ff6b6b}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--fg:#14161c;--muted:#5d6472;--border:#e2e5ea}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
.btn{display:block;width:100%;padding:11px 14px;border-radius:9px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:10px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.quiet{color:var(--muted);font-weight:500}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg);font:inherit}
.err{color:var(--danger);font-size:14px;margin-bottom:12px}.sep{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:14px 0}.sep:before,.sep:after{content:"";flex:1;border-top:1px solid var(--border)}
.who{display:flex;gap:12px;align-items:center;margin-bottom:18px}.who img{width:40px;height:40px;border-radius:50%}.small{font-size:12px}
`;

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Atomesus</title><style>${CSS}</style></head><body><main class="card">${body}</main></body></html>`;
}

function signInPage({ flow, error, github, google }) {
  const isSignup = flow.screen === "signup";
  const q = `flow=${encodeURIComponent(flow.id)}`;
  return layout(
    isSignup ? "Sign up" : "Log in",
    `<h1>${isSignup ? "Create your Atomesus account" : "Log in to Atomesus"}</h1>
<p>Then you'll be sent back to the Atomesus desktop app.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
${github ? `<a class="btn" href="/api/auth/github?${q}">Continue with GitHub</a>` : ""}
${google ? `<a class="btn" href="/api/auth/google?${q}">Continue with Google</a>` : ""}
${github || google ? `<div class="sep">or use email</div>` : ""}
<form method="post" action="/desktop/${isSignup ? "signup" : "login"}">
<input type="hidden" name="flow" value="${esc(flow.id)}">
${isSignup ? `<label>Name</label><input name="name" required maxlength="120">` : ""}
<label>Email</label><input name="email" type="email" required autocomplete="email">
<label>Password</label><input name="password" type="password" required minlength="8" autocomplete="${isSignup ? "new-password" : "current-password"}">
${isSignup ? `<label>Code from your email <span class="small">(leave empty to get one)</span></label><input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">` : ""}
<button class="btn primary" type="submit" style="margin-top:14px">${isSignup ? "Continue" : "Log in"}</button>
</form>
<a class="btn quiet" href="/desktop/${isSignup ? "login" : "signup"}?${q}">${isSignup ? "Already have an account? Log in" : "No account? Sign up"}</a>
<form method="post" action="/desktop/cancel"><input type="hidden" name="flow" value="${esc(flow.id)}"><button class="btn quiet" type="submit">Cancel</button></form>`
  );
}

function confirmPage({ flow, user }) {
  return layout(
    "Sign in to desktop",
    `<h1>Sign in to Atomesus desktop?</h1>
<div class="who">${user.image ? `<img src="${esc(user.image)}" alt="">` : ""}<div><div><strong>${esc(user.name || user.email)}</strong></div><div class="small" style="color:var(--muted)">${esc(user.email)}</div></div></div>
<form method="post" action="/desktop/approve"><input type="hidden" name="flow" value="${esc(flow.id)}"><button class="btn primary" type="submit">Sign in</button></form>
<form method="post" action="/desktop/cancel"><input type="hidden" name="flow" value="${esc(flow.id)}"><button class="btn quiet" type="submit">Cancel</button></form>
<form method="post" action="/desktop/switch"><input type="hidden" name="flow" value="${esc(flow.id)}"><button class="btn quiet small" type="submit">Use a different account</button></form>`
  );
}

function donePage({ ok, message, redirectTo }) {
  return layout(
    ok ? "All set" : "Sign-in cancelled",
    `${redirectTo ? `<meta http-equiv="refresh" content="0;url=${esc(redirectTo)}">` : ""}
<h1>${ok ? "All set" : "Sign-in cancelled"}</h1>
<p>${esc(message)}</p>
${redirectTo ? `<a class="btn primary" href="${esc(redirectTo)}">Open Atomesus</a>` : ""}`
  );
}

function errorPage(message) {
  return layout("Error", `<h1>Something went wrong</h1><p>${esc(message)}</p>`);
}

module.exports = { signInPage, confirmPage, donePage, errorPage };
