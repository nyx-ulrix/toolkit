import type { Opt, Out, Tool, Values } from './types';

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...kids: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

export function download(blob: Blob, name: string) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Swaps the extension of a file name. */
export const rename = (name: string, ext: string, suffix = '') => name.replace(/\.[^.]+$/, '') + suffix + '.' + ext;

/** Aborted whenever the user navigates to another tool, so paste listeners don't pile up. */
let pageAbort = new AbortController();
export const resetPage = () => (pageAbort.abort(), (pageAbort = new AbortController()));
export const pageSignal = () => pageAbort.signal;

/** Wires up a drop zone: click, keyboard, drag and drop, and paste. */
export function dropZone(opts: { accept: string; multiple?: boolean; title?: string; hint?: string; onFiles: (files: File[]) => void }) {
  const picker = h('input', { type: 'file', accept: opts.accept, multiple: opts.multiple !== false, hidden: true });
  const zone = h('div', { class: 'drop', tabindex: 0, role: 'button' },
    h('strong', {}, opts.title ?? 'Drop files here'),
    h('span', {}, opts.hint ?? 'or click to choose. You can also paste.'), picker);
  const give = (list: Iterable<File> | null | undefined) => {
    const files = [...(list ?? [])];
    if (files.length) opts.onFiles(opts.multiple === false ? files.slice(0, 1) : files);
  };
  picker.addEventListener('change', () => (give(picker.files), (picker.value = '')));
  zone.addEventListener('click', (e) => e.target !== picker && picker.click());
  zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), picker.click()));
  zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.classList.add('over')));
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => (e.preventDefault(), zone.classList.remove('over'), give(e.dataTransfer?.files)));
  window.addEventListener('paste', (e) => give(e.clipboardData?.files), { signal: pageAbort.signal });
  return zone;
}

function optField(o: Opt, values: Values, changed: () => void) {
  let input: HTMLInputElement | HTMLSelectElement;
  const val = values[o.key];
  if (o.type === 'select') {
    input = h('select', {}, ...o.choices!.map(([v, l]) => h('option', { value: v, selected: v === String(val) }, l)));
  } else {
    input = h('input', {
      type: o.type,
      min: o.min, max: o.max, step: o.step,
      value: o.type === 'checkbox' ? undefined : String(val),
      checked: o.type === 'checkbox' && val === true,
    });
  }
  const readout = o.type === 'range' ? h('output', { class: 'readout' }, String(val)) : null;
  input.addEventListener('input', () => {
    const el = input as HTMLInputElement;
    values[o.key] = o.type === 'checkbox' ? el.checked : o.type === 'range' || o.type === 'number' ? Number(el.value) : el.value;
    if (readout) readout.textContent = el.value;
    changed();
  });
  return h('label', { class: `field ${o.type === 'checkbox' ? 'field-check' : ''}` }, h('span', {}, o.label), input, readout, o.hint ? h('small', {}, o.hint) : null);
}

/** Small round-cornered-free close button for the top right of a preview. */
export const xButton = (label: string, on: () => void) =>
  h('button', { class: 'x-btn', 'aria-label': label, title: label, onclick: (e: Event) => (e.stopPropagation(), on()) }, '×');

/** Builds a preview block for one result; the preview itself is created lazily. */
function resultBlock(out: Out, from: File, onClose: () => void) {
  const url = URL.createObjectURL(out.blob);
  const delta = out.blob.size && from.size ? ` (${out.blob.size <= from.size ? '-' : '+'}${Math.abs(Math.round((1 - out.blob.size / from.size) * 100))}%)` : '';
  const body = h('div', { class: 'result-body' }, h('p', { class: 'pv-more' }, 'Preparing preview...'));
  const toggle = h('button', { class: 'link', 'aria-expanded': 'true' }, 'Hide preview');
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.textContent = open ? 'Hide preview' : 'Show preview';
    toggle.setAttribute('aria-expanded', String(open));
  });
  import('./preview').then(({ preview }) => preview(out.blob, out.name)).then((el) => (body.firstElementChild?.matches('.pv-more') && body.firstElementChild.remove(), body.prepend(el)));
  const block = h('div', { class: 'result' },
    h('div', { class: 'result-head' },
      h('a', { class: 'btn small', href: url, download: out.name }, 'Download'),
      h('b', {}, out.name),
      h('small', {}, fmtBytes(out.blob.size) + delta + (out.note ? '. ' + out.note : '')),
      toggle),
    body);
  body.append(xButton(`Remove ${out.name} from this page`, () => (block.remove(), URL.revokeObjectURL(url), onClose())));
  return block;
}

export function toolHeader(tool: Tool) {
  return h('header', { class: 'tool-head' },
    h('a', { class: 'crumb', href: '#/' }, 'All tools'),
    h('h1', {}, tool.title),
    h('p', { class: 'lede' }, tool.desc),
    tool.note ? h('p', { class: 'note' }, tool.note) : null);
}

/** Builds the whole page for a tool: drop zone, options, queue with input previews, results with previews. */
export function mountTool(root: HTMLElement, tool: Tool) {
  const values: Values = Object.fromEntries((tool.opts ?? []).map((o) => [o.key, o.value]));
  let files: File[] = [];
  let busy = false;

  const fields = (tool.opts ?? []).map((o) => ({ o, el: optField(o, values, syncVisibility) }));
  function syncVisibility() {
    for (const { o, el } of fields) el.hidden = o.show ? !o.show(values) : false;
  }
  syncVisibility();

  const list = h('div', { class: 'queue' });
  const run = h('button', { class: 'btn primary', disabled: true }, 'Convert');
  const regen = h('button', { class: 'btn primary regen', disabled: true }, 'Regenerate');
  const zipBtn = h('button', { class: 'btn', hidden: true }, 'Download all (.zip)');
  const clear = h('button', { class: 'btn quiet', hidden: true }, 'Clear');
  const drop = dropZone({ accept: tool.accept, onFiles: (f) => add(f) });

  const rows = new Map<File, { status: HTMLElement; bar: HTMLProgressElement; outs: HTMLElement }>();
  const allOuts: Out[] = [];
  const outsOf = new Map<File, Out[]>();
  const dropOuts = (list: Out[]) => {
    for (const o of list) allOuts.splice(allOuts.indexOf(o), 1);
    zipBtn.hidden = allOuts.length < 2;
  };

  function render() {
    list.replaceChildren();
    rows.clear();
    for (const f of files) {
      const status = h('span', { class: 'status' }, 'Ready');
      const bar = h('progress', { max: 1, value: 0, hidden: true });
      const outs = h('div', { class: 'outs' });
      const thumb = h('div', { class: 'thumb' });
      import('./preview').then(({ preview }) => preview(f, f.name, true)).then((el) => thumb.replaceChildren(el));
      const remove = () => {
        dropOuts(outsOf.get(f) ?? []);
        outsOf.delete(f);
        files = files.filter((x) => x !== f);
        render();
      };
      rows.set(f, { status, bar, outs });
      list.append(h('article', { class: 'row' }, h('div', { class: 'thumb-wrap' }, thumb, xButton(`Remove ${f.name} and its results`, remove)),
        h('div', { class: 'row-main' }, h('div', { class: 'head' }, h('b', {}, f.name), h('small', {}, fmtBytes(f.size)), status), bar, outs)));
    }
    run.disabled = regen.disabled = busy || !files.length;
    clear.hidden = !files.length;
  }

  function add(added: Iterable<File>) {
    files = [...files, ...added];
    render();
  }

  async function go() {
    busy = true;
    allOuts.length = 0;
    outsOf.clear();
    zipBtn.hidden = true;
    run.disabled = regen.disabled = true;
    for (const f of files) {
      const r = rows.get(f)!;
      r.outs.replaceChildren();
      r.bar.hidden = false;
      r.bar.value = 0;
      r.status.className = 'status';
      r.status.textContent = 'Working...';
      const t0 = performance.now();
      try {
        const outs = await tool.run(f, { ...values }, {
          progress: (p, msg) => {
            r.bar.value = p;
            if (msg) r.status.textContent = msg;
          },
        });
        r.status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
        r.status.classList.add('ok');
        outsOf.set(f, outs);
        for (const out of outs) {
          allOuts.push(out);
          r.outs.append(resultBlock(out, f, () => dropOuts([out])));
        }
      } catch (e) {
        console.error(e);
        r.status.textContent = 'Failed: ' + (e instanceof Error ? e.message : String(e));
        r.status.classList.add('err');
      }
      r.bar.hidden = true;
    }
    busy = false;
    run.disabled = regen.disabled = false;
    zipBtn.hidden = allOuts.length < 2;
  }

  run.addEventListener('click', go);
  regen.addEventListener('click', go);
  clear.addEventListener('click', () => ((files = []), allOuts.splice(0), outsOf.clear(), (zipBtn.hidden = true), render()));
  zipBtn.addEventListener('click', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const seen = new Set<string>();
    for (const o of allOuts) {
      let n = o.name;
      for (let i = 2; seen.has(n); i++) n = o.name.replace(/(\.[^.]*)?$/, `-${i}$1`);
      seen.add(n);
      zip.file(n, o.blob);
    }
    download(await zip.generateAsync({ type: 'blob' }), `${tool.id}.zip`);
  });

  root.replaceChildren(toolHeader(tool),
    h('div', { class: 'workspace' },
      h('div', { class: 'stage' }, drop, h('div', { class: 'actions' }, run, zipBtn, clear), list),
      h('aside', { class: 'panel', 'aria-label': 'Options' },
        fields.length ? h('div', { class: 'opts' }, ...fields.map((f) => f.el)) : h('p', { class: 'pv-more' }, 'No options for this tool.'),
        regen)));
  render();
}
