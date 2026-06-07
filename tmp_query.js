const { createClient } = require('@libsql/client');
const c = createClient({ url: 'file:/app/data/subsense.db' });
// Check all proxy-wrapped URLs to see what domains are being wrapped
c.execute(
  "SELECT subtitles FROM subtitle_cache WHERE subtitles LIKE '%api/subtitle/vtt/http%' ORDER BY created_at DESC LIMIT 20"
).then(r => {
  const domains = {};
  for (const row of r.rows) {
    const subs = JSON.parse(row.subtitles);
    for (const s of subs) {
      if (!s.url || !s.url.includes('api/subtitle/vtt/http')) continue;
      const inner = s.url.split('api/subtitle/vtt/')[1];
      if (!inner) continue;
      try {
        const u = new URL(inner);
        const key = `${u.hostname} (source=${s.source})`;
        domains[key] = (domains[key] || 0) + 1;
      } catch {}
    }
  }
  Object.entries(domains).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`${v}x ${k}`));
}).catch(e => console.error(e.message));
