import './style.css';
import { groups, tools } from './tools';
import { h, mountTool, resetPage } from './ui';

const app = document.getElementById('app')!;
const main = h('main');

const BLURBS: Record<string, string> = {
  Image: 'Cut subjects out of photos.',
  Convert: 'Change formats without an upload.',
  Optimize: 'Smaller files and searchable scans.',
  Create: 'Turn pictures into pixel art and halftone.',
};

let onHome = false;

function home() {
  document.title = 'Toolkit';
  onHome = true;
  main.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, h('span', {}, 'File tools'), h('span', {}, 'that never ', h('em', {}, 'leave')), h('span', {}, 'your computer.')),
      h('div', { class: 'hero-foot' },
        h('p', { class: 'lede' }, 'Cut out backgrounds, convert, compress and read scans. It all runs in your browser, so nothing is uploaded.'),
        h('div', { class: 'cta-row' },
          h('a', { class: 'btn primary', href: '#/remove-background' }, 'Remove a background'),
          h('a', { class: 'btn', href: '#index' }, 'See all tools')))),
    h('section', { class: 'index', id: 'index' },
      h('h2', {}, 'All tools'),
      ...groups.map((g) =>
        h('div', { class: 'group', id: 'g-' + g.toLowerCase() },
          h('div', { class: 'group-head' }, h('h3', {}, g), h('p', {}, BLURBS[g])),
          h('ul', { class: 'entries' }, ...tools.filter((t) => t.group === g).map((t) =>
            h('li', {}, h('a', { href: '#/' + t.id }, h('span', { class: 't' }, t.title, h('i', {}, '→')), h('span', { class: 'd' }, t.desc)))))))),
    h('section', { class: 'statement' },
      h('h2', {}, 'Nothing is ', h('em', {}, 'uploaded.'), h('br'), 'Nothing is stored.'),
      h('div', { class: 'statement-body' },
        h('p', {}, 'Every conversion happens on your own processor. Close the tab and the files are gone.'),
        h('p', {}, 'The first use of some tools downloads an engine or an AI model once, and your browser keeps it afterwards.'),
        h('ul', {},
          h('li', {}, 'Works in current Chrome, Edge and Firefox'),
          h('li', {}, 'A graphics card speeds up background removal'),
          h('li', {}, 'Large videos need free memory, about 4 GB')))),
  );
}

function route() {
  resetPage();
  const id = location.hash.replace(/^#\//, '');
  const tool = tools.find((t) => t.id === id);
  if (!tool) {
    if (!onHome || location.hash === '#/' || location.hash === '') home();
    const target = location.hash.startsWith('#g-') || location.hash === '#index' ? document.querySelector(location.hash) : null;
    return target ? target.scrollIntoView() : scrollTo(0, 0);
  }
  onHome = false;
  document.title = tool.title + ' - Toolkit';
  if (tool.mount) tool.mount(main);
  else mountTool(main, tool);
  scrollTo(0, 0);
}

const navLink = (g: string) => h('a', { href: '#g-' + g.toLowerCase() }, g);

app.append(
  h('header', { class: 'mast' },
    h('div', { class: 'mast-in' },
      h('a', { href: '#/', class: 'brand' }, 'Toolkit'),
      h('nav', { 'aria-label': 'Tool groups' }, ...groups.map(navLink)))),
  main,
  h('footer', { class: 'foot' },
    h('div', { class: 'foot-in' },
      h('p', {}, 'Files are processed in your browser and never leave your device. Open-source engines: ffmpeg.wasm, pdf.js, Tesseract, onnxruntime-web and others.'),
      h('a', { href: 'https://liewjiaen.com' }, 'More at liewjiaen.com'))),
);
addEventListener('hashchange', route);
route();
