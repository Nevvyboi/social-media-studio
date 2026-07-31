// The campaign view. One page, server rendered, no build step.
//
// It exists to answer one question at a glance: which posts went out, which
// are waiting, and which failed. A dashboard that needs a legend to read has
// already lost the argument.

function renderCampaigns(campaigns) {
  const rows = campaigns.length
    ? campaigns.map(row).join("")
    : `<tr><td colspan="5" class="empty">No campaigns yet. POST a blog post to /campaigns to start one.</td></tr>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>Campaigns</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 3rem auto; max-width: 62rem; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  p.lede { margin: 0 0 2rem; opacity: .65; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; opacity: .55; padding: 0 .75rem .5rem 0; }
  td { padding: .7rem .75rem .7rem 0; border-top: 1px solid rgba(128,128,128,.25); vertical-align: top; }
  td.empty { opacity: .6; text-align: center; padding: 3rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  a { color: inherit; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem; border: 1px solid; }
  .ok { border-color: rgba(46,160,67,.5); }
  .bad { border-color: rgba(218,54,51,.6); }
  .wait { border-color: rgba(128,128,128,.45); opacity: .8; }
  code { font-size: .85em; opacity: .8; }
</style>
<h1>Campaigns</h1>
<p class="lede">One blog post, one row. Status comes from the platform's signed delivery callback, not from the moment we sent it.</p>
<table>
  <thead><tr><th>Post</th><th>Posts</th><th>Published</th><th>Failed</th><th>Created</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function row(c) {
  const pending = c.posts - c.published - c.failed;
  return `<tr>
    <td><a href="/campaigns/${escape(c.id)}">${escape(c.title)}</a><br><code>${escape(c.url)}</code></td>
    <td>${c.posts}</td>
    <td><span class="pill ${c.published ? "ok" : "wait"}">${c.published}</span></td>
    <td><span class="pill ${c.failed ? "bad" : "wait"}">${c.failed}</span>${pending ? ` <span class="pill wait">${pending} waiting</span>` : ""}</td>
    <td>${new Date(c.created_at).toISOString().replace("T", " ").slice(0, 16)}</td>
  </tr>`;
}

function escape(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

module.exports = { renderCampaigns };
