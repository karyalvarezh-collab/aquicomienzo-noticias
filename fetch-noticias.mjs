/**
 * Aquí Comienzo — actualizador de noticias (repositorio aquicomienzo-noticias).
 *
 * Estructura esperada del repositorio:
 *   noticias.json
 *   fetch-noticias.mjs
 *   .github/workflows/actualizar-noticias.yml
 *
 * Requiere Node.js 20 o superior. Sin dependencias externas.
 *
 * Reglas:
 * - Lee canales RSS 2.0 y Atom. Si una fuente falla o no tiene un formato
 *   compatible, se omite y se siguen consultando las demás.
 * - Si ninguna fuente entrega noticias válidas, noticias.json NO se modifica
 *   (ni siquiera su fecha de actualización).
 * - Conserva las noticias anteriores, evita duplicados por enlace original
 *   y guarda las 12 más recientes, ordenadas por fecha.
 * - Nunca inventa contenido: título, fecha y enlace vienen de la fuente.
 *
 * Uso: node fetch-noticias.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const DATA_FILE = new URL("./noticias.json", import.meta.url);
const MAX_ITEMS = 12;
const TIMEOUT_MS = 20000;

const FEEDS = [
  { name: "Mi Futuro (Mineduc)", url: "https://www.mifuturo.cl/feed/" },
  { name: "DEMRE", url: "https://demre.cl/feed" },
  { name: "JUNAEB", url: "https://www.junaeb.cl/feed/" },
];

const TOPICS = [
  [/\bpaes\b/i, "PAES"],
  [/admis/i, "Admisión"],
  [/beca/i, "Becas"],
  [/gratuidad/i, "Gratuidad"],
  [/t[ée]cnica|t[ée]cnico|\bcft\b|instituto/i, "Formación técnica"],
  [/convocatoria|postul/i, "Convocatorias"],
  [/superior|universidad/i, "Educación superior"],
];

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Contenido de la primera etiqueta <name>, sin CDATA. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function topicFor(text) {
  for (const [re, topic] of TOPICS) if (re.test(text)) return topic;
  return "Oportunidades";
}

/** Enlace de una entrada Atom: prefiere rel="alternate" o sin rel. */
function atomLink(entry) {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const attr = (a, n) => (a.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1];
  const chosen =
    links.find((a) => !attr(a, "rel") || attr(a, "rel") === "alternate") || links[0];
  return chosen ? decodeEntities(attr(chosen, "href") || "") : "";
}

function buildItem({ title, link, date, summary }, sourceName) {
  title = stripHtml(title);
  link = decodeEntities(link).trim();
  const d = new Date(date);
  if (!title || !/^https?:\/\//i.test(link) || Number.isNaN(d.getTime())) return null;
  let s = stripHtml(summary);
  if (s.length > 220) s = s.slice(0, 220).replace(/\s+\S*$/, "") + "…";
  if (!s) s = "Revisa los detalles en la publicación original.";
  return {
    id: link,
    title,
    summary: s,
    publishedAt: d.toISOString().slice(0, 10),
    sourceName,
    sourceUrl: link,
    topic: topicFor(`${title} ${s}`),
  };
}

/** Interpreta RSS 2.0 o Atom. Devuelve null si el formato no es compatible. */
export function parseFeed(xml, sourceName) {
  if (/<rss[\s>]|<channel[\s>]/i.test(xml)) {
    return [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)]
      .map((m) =>
        buildItem(
          {
            title: tag(m[1], "title"),
            link: tag(m[1], "link") || tag(m[1], "guid"),
            date: tag(m[1], "pubDate") || tag(m[1], "dc:date"),
            summary: tag(m[1], "description"),
          },
          sourceName,
        ),
      )
      .filter(Boolean);
  }
  if (/<feed[\s>]/i.test(xml)) {
    return [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)]
      .map((m) =>
        buildItem(
          {
            title: tag(m[1], "title"),
            link: atomLink(m[1]),
            date: tag(m[1], "published") || tag(m[1], "updated"),
            summary: tag(m[1], "summary") || tag(m[1], "content"),
          },
          sourceName,
        ),
      )
      .filter(Boolean);
  }
  return null;
}

function readCurrent() {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function main() {
  const previous = readCurrent();
  const byLink = new Map(previous.map((n) => [n.sourceUrl, n]));
  let okSources = 0;

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "user-agent": "AquiComienzoBot/1.0 (+https://aquicomienzo.cl)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text(), feed.name);
      if (items === null) throw new Error("formato no compatible (no es RSS ni Atom)");
      if (items.length === 0) throw new Error("sin noticias válidas");
      for (const item of items) byLink.set(item.sourceUrl, item);
      okSources++;
      console.log(`OK        ${feed.name}: ${items.length} noticias`);
    } catch (err) {
      console.log(`OMITIDA   ${feed.name}: ${err.message}`);
    }
  }

  if (okSources === 0) {
    console.log("Ninguna fuente respondió. noticias.json no se modifica.");
    return;
  }

  const items = [...byLink.values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, MAX_ITEMS);

  writeFileSync(
    DATA_FILE,
    JSON.stringify({ actualizada: new Date().toISOString(), items }, null, 2) + "\n",
  );
  console.log(`Total: ${items.length} noticias guardadas (${okSources} fuente(s) con datos).`);
}

main().catch((err) => {
  console.error("Error inesperado:", err.message);
  process.exitCode = 1;
});
