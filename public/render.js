(function () {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtProjectsAdmin(arr, sep, off = 0) {
    if (!Array.isArray(arr)) return '';
    return arr.filter((p) => p && (p.name || p.location)).map((p, i) => {
      const units = (p.units || []).filter((u) => u.type || u.price || u.size).map((u) => `${u.type || '?'} / ${u.price || '?'} / ${u.size || '?'}`).join('; ');
      const am = [...(p.amenities || []), p.amenities_other].filter(Boolean).join(', ');
      return [`Proyecto ${i + 1 + off}: ${p.name || '(sin nombre)'}`, `Ubicación: ${p.location || ''}`, `Tipo: ${p.type || ''}`, `Unidades: ${units}`, `Entrega: ${p.delivery || ''}`, `Plan de pago: ${p.payment || ''}`, `Amenidades: ${am}`].join(sep.in);
    }).join(sep.out);
  }
  // Devuelve el HTML de todas las respuestas de un cliente. fileUrl(id) da la dirección de descarga de cada archivo.
  window.renderResponseHtml = function (r, fileUrl) {
  let out = '';
    for (const it of r.schema.items) {
      if (it.kind === 'section') out += `<div class="sec">${esc(it.title)}</div>`;
      else if (it.kind === 'question') {
        const a = r.answers[it.id];
        if (it.type === 'project') {
          const prs = Array.isArray(a) ? a : [];
          const blocks = prs.map((pr, n) => {
            const fl = r.files.filter(f => f.question_id === it.id + '#' + pr.id).map(f => `<div><a href="${fileUrl(f.id)}">📎 ${esc(f.filename)}</a></div>`).join('');
            const t = fmtProjectsAdmin([pr], { in: '\n', out: '' }, n);
            const lk = (pr.links || []).map(l => `<div><a href="${esc(l)}" target="_blank" rel="noopener">🔗 ${esc(l)}</a></div>`).join('');
            if (!t && !fl && !lk) return '';
            return `<div style="margin-bottom:12px">${esc(t || 'Proyecto ' + (n + 1) + ' (sin datos)')}${fl ? '<div class="muted" style="margin-top:4px">Archivos del proyecto:</div>' + fl : ''}${lk ? '<div class="muted" style="margin-top:4px">Enlaces del proyecto:</div>' + lk : ''}</div>`;
          }).filter(Boolean).join('');
          out += `<div class="ans"><div class="l">${esc(it.label)}</div><div class="a">${blocks || '<span class="muted">— sin respuesta —</span>'}</div></div>`; continue; }
        let txt = Array.isArray(a) ? a.join('\n') : (a && typeof a === 'object' ? [a, ...(a.extra || [])].map((x, i) => [x.q ? (i ? 'Pregunta adicional ' + i + ': ' : 'Pregunta: ') + x.q : '', x.a ? 'Respuesta: ' + x.a : ''].filter(Boolean).join(' / ')).filter(Boolean).join('\n\n') : (a ?? ''));
        const fl = r.files.filter(f => f.question_id === it.id).map(f => `<div><a href="${fileUrl(f.id)}">📎 ${esc(f.filename)}</a></div>`).join('');
        out += `<div class="ans"><div class="l">${esc(it.label)}</div><div class="a">${txt === '' && !fl ? '<span class="muted">— sin respuesta —</span>' : esc(txt)}${fl}</div></div>`;
      }
    }
    return out;
  };
})();
