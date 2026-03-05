import React, { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 15;
const STORAGE_KEY = "pubscroll_profile_v2";

// Interest profile shape
const defaultProfile = {
  journals: {},      // journal -> score
  keywords: {},      // keyword -> score
  pubTypes: {},      // pubtype -> score
  seenPmids: [],     // avoid re-showing
  totalSeen: 0,
};

// Seed topics for cold start
const SEED_TOPICS = [
  { label: "🔥 Trending", query: `("last 2 years"[PDat]) AND ("clinical trial"[pt] OR "meta-analysis"[pt] OR "systematic review"[pt])` },
  { label: "🧠 Neuro", query: "neuroscience OR neuroplasticity OR connectome" },
  { label: "🧬 Genomics", query: "CRISPR OR gene editing OR genomics" },
  { label: "🦠 Microbiome", query: "gut microbiome OR microbiota" },
  { label: "💊 Oncology", query: "cancer immunotherapy OR checkpoint inhibitor" },
  { label: "🫀 Cardio", query: "cardiovascular disease OR heart failure" },
  { label: "🤖 AI+Med", query: "artificial intelligence clinical OR deep learning radiology" },
  { label: "🧪 mRNA", query: "mRNA vaccine OR lipid nanoparticle delivery" },
];

// ─── Proxy fetch ──────────────────────────────────────────────────────────────
async function pfetch(url) {
  const proxies = [
    u => fetch("https://corsproxy.io/?" + u),
    u => fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(u)),
    u => fetch("https://corsproxy.org/?" + encodeURIComponent(u)),
    u => fetch(u),
  ];
  for (const p of proxies) {
    try {
      const r = await p(url);
      if (r.ok) return r;
    } catch (_) {}
  }
  throw new Error("All proxies failed");
}

// ─── PubMed API ───────────────────────────────────────────────────────────────
async function searchPMIDs(query, retstart = 0, retmax = PAGE_SIZE) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retstart=${retstart}&sort=relevance&retmode=json`;
  const r = await pfetch(url);
  const d = await r.json();
  return { ids: d.esearchresult.idlist || [], total: parseInt(d.esearchresult.count || "0", 10) };
}

async function fetchSummaries(ids) {
  if (!ids.length) return [];
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
  const r = await pfetch(url);
  const d = await r.json();
  return ids.map(id => d.result[id]).filter(Boolean);
}

async function fetchAbstract(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
  const r = await pfetch(url);
  const text = await r.text();
  const lines = text.split("\n");
  let inAbs = false, parts = [];
  for (const line of lines) {
    if (line.startsWith("AB  -")) { inAbs = true; parts.push(line.replace("AB  -", "").trim()); }
    else if (inAbs && line.startsWith("      ")) parts.push(line.trim());
    else if (inAbs) break;
  }
  return parts.join(" ") || "Abstract not available.";
}

// ─── Altmetric API (free, no key needed for basic score) ─────────────────────
const altmetricCache = {};
async function fetchAltmetric(doi) {
  if (!doi) return null;
  if (altmetricCache[doi] !== undefined) return altmetricCache[doi];
  try {
    const r = await fetch(`https://api.altmetric.com/v1/doi/${doi}`);
    if (!r.ok) { altmetricCache[doi] = null; return null; }
    const d = await r.json();
    altmetricCache[doi] = d.score || null;
    return altmetricCache[doi];
  } catch { altmetricCache[doi] = null; return null; }
}

// ─── Figure fetching ─────────────────────────────────────────────────────────
const figureCache = {};

function extractPmcId(paper) {
  const ids = paper.articleids || [];
  const pmc = ids.find(a => a.idtype === "pmc");
  return pmc ? pmc.value.replace("PMC", "") : null;
}

// Europe PMC figures API — works cross-origin, good coverage for OA papers
async function fetchEuropePmcFigure(pmcid) {
  if (!pmcid) return null;
  try {
    const r = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/PMC${pmcid}/figures?format=json`);
    if (!r.ok) return null;
    const d = await r.json();
    const figs = d?.figures?.figure;
    if (!figs?.length) return null;
    // Get first figure with a real image URL
    for (const fig of figs) {
      const url = fig?.url || fig?.httpUrl;
      if (url && (url.includes("http"))) return url;
    }
    return null;
  } catch { return null; }
}

// OpenAlex — get paper metadata including OA PDF link
async function fetchOpenAlexFigure(doi) {
  if (!doi) return null;
  try {
    const r = await fetch(`https://api.openalex.org/works/https://doi.org/${doi}?select=best_oa_location,primary_location`);
    if (!r.ok) return null;
    const d = await r.json();
    // Get PDF URL if available, use pdf.js thumbnail via a proxy
    const pdfUrl = d?.best_oa_location?.pdf_url;
    return pdfUrl || null;
  } catch { return null; }
}

// Hardcoded high-quality topic images from Unsplash (direct CDN URLs, always work)
const TOPIC_IMAGES = {
  neuro: [
    "https://images.unsplash.com/photo-1564325724739-bae0bd08762c?w=800",
    "https://images.unsplash.com/photo-1559757175-0eb30cd8c063?w=800",
    "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800",
  ],
  cardio: [
    "https://images.unsplash.com/photo-1530026186672-2cd00ffc50fe?w=800",
    "https://images.unsplash.com/photo-1628348068343-c6a848d2b6dd?w=800",
  ],
  cancer: [
    "https://images.unsplash.com/photo-1576086213369-97a306d36557?w=800",
    "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=800",
  ],
  genetics: [
    "https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=800",
    "https://images.unsplash.com/photo-1518152006812-edab29b069ac?w=800",
  ],
  micro: [
    "https://images.unsplash.com/photo-1583912267550-d44c9c3b21d6?w=800",
    "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800",
  ],
  immune: [
    "https://images.unsplash.com/photo-1584036561566-baf8f5f1b144?w=800",
    "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=800",
  ],
  imaging: [
    "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=800",
    "https://images.unsplash.com/photo-1516069677018-378515003435?w=800",
  ],
  surgery: [
    "https://images.unsplash.com/photo-1551190822-a9333d879b1f?w=800",
    "https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=800",
  ],
  pharma: [
    "https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=800",
    "https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=800",
  ],
  lab: [
    "https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=800",
    "https://images.unsplash.com/photo-1576319155264-99536e0be1ee?w=800",
    "https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?w=800",
    "https://images.unsplash.com/photo-1614935151651-0bea6508db6b?w=800",
  ],
};

function getTopicImageUrl(paper) {
  const t = (paper.title || "").toLowerCase();
  const journal = (paper.fulljournalname || "").toLowerCase();
  const text = t + " " + journal;

  let bucket;
  if (/brain|neural|neuro|cognit|alzheim|parkinson|epilep|cerebell|hippoc|cortex/.test(text)) bucket = "neuro";
  else if (/heart|cardiac|cardio|coronary|vascular|arterial|atrial|myocard/.test(text)) bucket = "cardio";
  else if (/cancer|tumor|oncol|carcinoma|leukemia|lymphoma|glioma|melanoma/.test(text)) bucket = "cancer";
  else if (/gene|genom|crispr|dna|rna|sequenc|chromos|allele|epigenet/.test(text)) bucket = "genetics";
  else if (/virus|viral|covid|sars|infect|bacteria|pathogen|microb|fungal|parasit/.test(text)) bucket = "micro";
  else if (/immun|vaccine|antibody|t cell|b cell|cytokine|inflam|autoimmun/.test(text)) bucket = "immune";
  else if (/mri|imaging|scan|radiolog|ultrasound|x-ray|tomograph|pet scan/.test(text)) bucket = "imaging";
  else if (/surgery|surgic|transplant|laparoscop|endoscop|biopsy/.test(text)) bucket = "surgery";
  else if (/drug|pharma|therapeut|treatment|trial|placebo|dose|efficacy/.test(text)) bucket = "pharma";
  else bucket = "lab";

  const imgs = TOPIC_IMAGES[bucket];
  return imgs[parseInt(paper.uid || "0") % imgs.length];
}

async function getCardFigure(paper, log) {
  const pmid = paper.uid;
  if (figureCache[pmid] !== undefined) {
    log && log("cached: " + (figureCache[pmid]||"null").toString().substring(0,80));
    return figureCache[pmid];
  }

  const pmcid = extractPmcId(paper);
  log && log(`pmid:${pmid} pmcid:${pmcid||"NONE"}`);

  if (pmcid) {
    // Try 1: Europe PMC figures endpoint
    try {
      const r = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/PMC${pmcid}/figures?format=json`);
      log && log(`EuroPMC status:${r.status}`);
      if (r.ok) {
        const d = await r.json();
        const figs = d?.figures?.figure;
        log && log(`figs:${figs?.length||0} first:${JSON.stringify(figs?.[0])?.substring(0,120)}`);
        if (figs?.length) {
          for (const fig of figs) {
            const url = fig?.url || fig?.httpUrl || fig?.thumbnailUrl || fig?.originalFileLink;
            if (url) { figureCache[pmid] = url; log && log("✓ EuroPMC: "+url.substring(0,80)); return url; }
          }
          // Log all keys so we can see what fields exist
          log && log("fig keys: " + Object.keys(figs[0]||{}).join(","));
        }
      }
    } catch(e) { log && log("EuroPMC err: "+e.message); }

    // Try 2: NCBI efetch XML to extract figure filenames
    try {
      const r2 = await pfetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid}&rettype=xml`);
      log && log(`NCBI efetch status:${r2.status}`);
      if (r2.ok) {
        const xml = await r2.text();
        // Find ALL graphic hrefs in the XML
        const allMatches = [...xml.matchAll(/<graphic[^>]*xlink:href="([^"]+)"/gi)];
        log && log(`NCBI graphics found: ${allMatches.length} refs: ${allMatches.slice(0,2).map(m=>m[1]).join(" | ")}`);
        for (const m of allMatches) {
          const href = m[1];
          // href is often like "pmc/articles/PMC123/bin/filename" or just "filename"
          // Try to construct the full NCBI bin URL
          let name = href.split("/").pop();
          // Remove extension if present, we'll try jpg
          const baseName = name.replace(/\.[^.]+$/, "");
          // Try direct URL first (some hrefs are already full paths)
          const candidates = [
            href.startsWith("http") ? href : null,
            `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcid}/bin/${baseName}.jpg`,
            `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcid}/bin/${baseName}.png`,
            `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcid}/bin/${name}`,
          ].filter(Boolean);
          log && log(`trying candidates: ${candidates[0]?.substring(0,80)}`);
          // Test the jpg URL via a HEAD request
          for (const candidate of candidates) {
            try {
              const test = await pfetch(candidate);
              log && log(`candidate ${candidate.substring(0,60)} -> ${test.status}`);
              if (test.ok) {
                figureCache[pmid] = candidate;
                log && log("✓ NCBI fig: " + candidate);
                return candidate;
              }
            } catch(e2) { log && log(`candidate err: ${e2.message}`); }
          }
        }
      }
    } catch(e) { log && log("NCBI err: "+e.message); }
  } else {
    // No pmcid — try looking it up via elink
    try {
      const r = await pfetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`);
      if (r.ok) {
        const d = await r.json();
        const links = d?.linksets?.[0]?.linksetdbs?.find(l=>l.dbto==="pmc")?.links;
        log && log(`elink pmc ids: ${JSON.stringify(links)}`);
      }
    } catch(e) { log && log("elink err: "+e.message); }
  }

  figureCache[pmid] = null;
  log && log("✗ no figure found");
  return null;
}

// ─── Profile helpers ──────────────────────────────────────────────────────────
function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultProfile, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultProfile };
}

function saveProfile(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {}
}

function extractKeywords(title = "") {
  const stopwords = new Set(["the","a","an","and","or","of","in","to","for","with","on","at","from","by","this","that","are","is","was","were","be","been","has","have","had","it","its","as","not","but","which","who","their","they","these","those","than","more","also","after","before","between","during","into","through","via","using","among"]);
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4 && !stopwords.has(w))
    .slice(0, 8);
}

function updateProfile(profile, paper, engagementType) {
  // engagementType: "skip" | "view" | "read" | "click"
  const weights = { skip: -0.5, view: 1, read: 2, click: 3 };
  const w = weights[engagementType] || 1;
  const p = { ...profile };
  p.journals = { ...p.journals };
  p.keywords = { ...p.keywords };
  p.pubTypes = { ...p.pubTypes };

  const journal = paper.fulljournalname || paper.source || "";
  if (journal) p.journals[journal] = (p.journals[journal] || 0) + w;

  const kws = extractKeywords(paper.title || "");
  kws.forEach(kw => { p.keywords[kw] = (p.keywords[kw] || 0) + w; });

  (paper.pubtype || []).forEach(pt => { p.pubTypes[pt] = (p.pubTypes[pt] || 0) + w; });

  if (engagementType !== "skip") {
    p.seenPmids = [...(p.seenPmids || []).slice(-200), paper.uid];
  }
  p.totalSeen = (p.totalSeen || 0) + 1;
  return p;
}

function scoreForProfile(paper, profile) {
  let score = 0;
  const journal = paper.fulljournalname || paper.source || "";
  score += (profile.journals[journal] || 0) * 1.5;
  const kws = extractKeywords(paper.title || "");
  kws.forEach(kw => { score += (profile.keywords[kw] || 0) * 1.0; });
  (paper.pubtype || []).forEach(pt => { score += (profile.pubTypes[pt] || 0) * 0.8; });
  return score;
}

function buildPersonalizedQuery(profile) {
  const topKws = Object.entries(profile.keywords)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);
  const topJournals = Object.entries(profile.journals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([j]) => `"${j}"[jour]`);
  if (!topKws.length && !topJournals.length) return null;
  const kwPart = topKws.length ? `(${topKws.join(" OR ")})` : "";
  const jPart = topJournals.length ? `(${topJournals.join(" OR ")})` : "";
  const parts = [kwPart, jPart].filter(Boolean);
  return parts.join(" OR ") + ' AND ("last 3 years"[PDat])';
}

function parseDoi(elocationid) {
  if (!elocationid) return null;
  const m = elocationid.match(/doi:\s*(10\.\S+)/i);
  return m ? m[1] : null;
}

function formatAuthors(authors) {
  if (!authors?.length) return "Unknown authors";
  const names = authors.slice(0, 3).map(a => a.name);
  return names.join(", ") + (authors.length > 3 ? ` +${authors.length - 3}` : "");
}

// ─── Abstract Overlay ─────────────────────────────────────────────────────────
function AbstractOverlay({ paper, altScore, onClose, onEngagement }) {
  const [abstract, setAbstract] = useState(null);
  const [loading, setLoading] = useState(true);
  const openTime = useRef(Date.now());

  useEffect(() => {
    onEngagement("read");
    fetchAbstract(paper.uid).then(a => { setAbstract(a); setLoading(false); });
    return () => {
      const secs = (Date.now() - openTime.current) / 1000;
      if (secs > 10) onEngagement("click"); // deep read
    };
  }, []);

  const doi = parseDoi(paper.elocationid);
  const journal = paper.fulljournalname || paper.source || "";
  const year = (paper.pubdate || "").substring(0, 4);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.88)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "flex-end", animation: "fadeIn 0.18s ease"
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#f7f9fc", width: "100%", maxHeight: "80vh",
        borderRadius: "20px 20px 0 0", overflowY: "auto",
        animation: "slideUp 0.25s cubic-bezier(0.32,0.72,0,1)",
        boxShadow: "0 -8px 40px rgba(0,0,0,0.4)"
      }}>
        {/* Drag handle */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "#d0d8e4" }} />
        </div>

        <div style={{ padding: "12px 24px 48px" }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.65rem", fontWeight: 800, color: "#1a6bb5", letterSpacing: "0.1em", textTransform: "uppercase" }}>Abstract</span>
              {altScore && (
                <span style={{
                  fontSize: "0.62rem", fontWeight: 700, padding: "2px 7px",
                  background: "rgba(245,158,11,0.12)", color: "#d97706",
                  border: "1px solid rgba(245,158,11,0.3)", borderRadius: 20,
                  letterSpacing: "0.05em"
                }}>⚡ {Math.round(altScore)} Altmetric</span>
              )}
            </div>
            <button onClick={onClose} style={{ background: "#e8edf4", border: "none", borderRadius: "50%", width: 30, height: 30, cursor: "pointer", fontSize: "0.9rem", display: "flex", alignItems: "center", justifyContent: "center", color: "#666" }}>✕</button>
          </div>

          {/* Journal + date */}
          <div style={{ fontSize: "0.68rem", color: "#1a6bb5", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            {journal}{year ? ` · ${year}` : ""}
          </div>

          {/* Title */}
          <h2 style={{ fontSize: "1rem", fontWeight: 700, color: "#0d1b2e", lineHeight: 1.5, marginBottom: 10, fontFamily: "Georgia, serif" }}>
            {paper.title}
          </h2>

          {/* Authors */}
          <p style={{ fontSize: "0.75rem", color: "#6b7a99", marginBottom: 18, fontFamily: "monospace" }}>
            {formatAuthors(paper.authors)}
          </p>

          {/* Abstract */}
          {loading
            ? <div style={{ display: "flex", gap: 8, alignItems: "center", color: "#999", fontSize: "0.85rem", fontStyle: "italic" }}>
                <div style={{ width: 16, height: 16, border: "2px solid #ddd", borderTopColor: "#1a6bb5", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                Loading abstract…
              </div>
            : <p style={{ fontSize: "0.88rem", lineHeight: 1.8, color: "#2d3a4a" }}>{abstract}</p>
          }

          {/* Links */}
          <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
            <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.uid}/`} target="_blank" rel="noreferrer"
              style={{ background: "#1a6bb5", color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: "0.82rem", fontWeight: 700, textDecoration: "none" }}>
              PubMed ↗
            </a>
            {doi && (
              <a href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer"
                style={{ border: "1.5px solid #1a6bb5", color: "#1a6bb5", padding: "10px 18px", borderRadius: 6, fontSize: "0.82rem", fontWeight: 700, textDecoration: "none", background: "transparent" }}>
                Full Text ↗
              </a>
            )}
            {doi && (
              <a href={`https://unpaywall.org/${doi}`} target="_blank" rel="noreferrer"
                style={{ border: "1.5px solid #d0d8e4", color: "#6b7a99", padding: "10px 18px", borderRadius: 6, fontSize: "0.82rem", fontWeight: 600, textDecoration: "none", background: "transparent" }}>
                Free PDF?
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Paper Card ───────────────────────────────────────────────────────────────
function PaperCard({ paper, altScore, onTap }) {
  const doi = parseDoi(paper.elocationid);
  const journal = paper.fulljournalname || paper.source || "";
  const year = (paper.pubdate || "").substring(0, 4);
  const pubType = paper.pubtype?.find(t =>
    ["Meta-Analysis","Systematic Review","Clinical Trial","Randomized Controlled Trial","Review"].includes(t)
  );
  const buzzy = altScore && altScore > 50;
  const accentColor = buzzy ? "#7ec850" : "#4a9edd";
  const bgGrad = buzzy
    ? "linear-gradient(160deg, #1a2a0a 0%, #0f1f0a 50%, #061208 100%)"
    : "linear-gradient(160deg, #0d2a4a 0%, #0a1f3a 50%, #061428 100%)";

  const [figureUrl, setFigureUrl] = useState(null);
  const [figLoaded, setFigLoaded] = useState(false);

  const [debugInfo, setDebugInfo] = useState("");

  useEffect(() => {
    let cancelled = false;
    const pmcid = extractPmcId(paper);
    setDebugInfo(`pmid:${paper.uid} pmcid:${pmcid || "none"}`);
    
    // Log every step
    getCardFigure(paper, (msg) => {
      if (!cancelled) setDebugInfo(msg);
    }).then(url => {
      if (!cancelled) {
        setFigureUrl(url);
        setDebugInfo(url ? `✓ ${url.substring(0,60)}` : "✗ no image");
      }
    });
    return () => { cancelled = true; };
  }, [paper.uid]);

  return (
    <div onClick={onTap} style={{
      width: "100%", height: "100%", background: bgGrad,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      cursor: "pointer", userSelect: "none", position: "relative", overflow: "hidden",
    }}>
      {/* Figure/topic background image — always present */}
      <img
        src={figureUrl || ""}
        onLoad={() => { setFigLoaded(true); setDebugInfo(prev => prev + " [IMG LOADED]"); }}
        onError={e => { setDebugInfo(prev => prev + " [IMG 404/CORS]"); e.target.style.opacity = 0; }}
        alt=""
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "cover", objectPosition: "center",
          opacity: figureUrl && figLoaded ? 0.28 : 0,
          transition: "opacity 1s ease",
          filter: "saturate(0.6) brightness(0.55)",
          pointerEvents: "none", zIndex: 1,
          display: figureUrl ? "block" : "none",
        }}
      />

      {/* Grid texture — always shown underneath */}
      <div style={{
        position: "absolute", inset: 0, opacity: 0.035, pointerEvents: "none",
        backgroundImage: `linear-gradient(${accentColor} 1px, transparent 1px), linear-gradient(90deg, ${accentColor} 1px, transparent 1px)`,
        backgroundSize: "40px 40px"
      }} />

      {/* Debug info - remove after testing */}
      {debugInfo && (
        <div style={{
          position: "absolute", bottom: 120, left: 12, right: 12, zIndex: 50,
          background: "rgba(0,0,0,0.85)", borderRadius: 4, padding: "6px 10px",
          fontSize: "0.55rem", color: "#0f0", fontFamily: "monospace",
          wordBreak: "break-all", lineHeight: 1.4, pointerEvents: "none"
        }}>{debugInfo}</div>
      )}

      {/* TOP: just a subtle fade for readability under the banner — no logo */}
      <div style={{
        position: "relative", zIndex: 2,
        padding: "calc(env(safe-area-inset-top, 0px) + 56px) 20px 0",
        background: "linear-gradient(180deg, rgba(4,10,20,0.6) 0%, transparent 100%)",
        display: "flex", justifyContent: "flex-end", pointerEvents: "none",
      }}>
        {altScore && altScore > 20 && (
          <span style={{
            fontSize: "0.6rem", fontWeight: 800, padding: "2px 8px",
            background: buzzy ? "rgba(126,200,80,0.15)" : "rgba(245,158,11,0.12)",
            color: buzzy ? "#7ec850" : "#f59e0b",
            border: `1px solid ${buzzy ? "rgba(126,200,80,0.35)" : "rgba(245,158,11,0.3)"}`,
            borderRadius: 20, letterSpacing: "0.05em", textTransform: "uppercase",
            pointerEvents: "auto",
          }}>⚡ {Math.round(altScore)}</span>
        )}
      </div>

      {/* BOTTOM: pinned to absolute bottom edge, no floating band */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        zIndex: 2,
        padding: "80px 24px calc(env(safe-area-inset-bottom, 0px) + 24px)",
        background: "linear-gradient(0deg, rgba(4,10,20,1) 0%, rgba(4,10,20,0.95) 55%, transparent 100%)",
      }}>
        {/* Journal + year + pubType */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.67rem", color: accentColor, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {journal.length > 44 ? journal.substring(0, 44) + "…" : journal}
          </span>
          {year && <span style={{ fontSize: "0.67rem", color: "#5a7a99", fontFamily: "monospace" }}>· {year}</span>}
          {pubType && (
            <span style={{
              fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.07em",
              textTransform: "uppercase", padding: "2px 7px",
              background: `${accentColor}18`, color: accentColor,
              border: `1px solid ${accentColor}40`, borderRadius: 3
            }}>{pubType}</span>
          )}
        </div>

        {/* Title */}
        <h2 style={{
          fontSize: "clamp(1.05rem, 4vw, 1.3rem)", fontWeight: 700, lineHeight: 1.5,
          color: "#e8f4ff", marginBottom: 12,
          fontFamily: "Georgia, serif", letterSpacing: "-0.01em",
          display: "-webkit-box", WebkitLineClamp: 5,
          WebkitBoxOrient: "vertical", overflow: "hidden"
        }}>{paper.title}</h2>

        {/* Authors */}
        <p style={{ fontSize: "0.77rem", color: "#7a9ab8", marginBottom: 18, fontFamily: "monospace", lineHeight: 1.5 }}>
          {formatAuthors(paper.authors)}
        </p>

        {/* CTA + links */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            background: `${accentColor}18`, border: `1px solid ${accentColor}40`,
            borderRadius: 20, padding: "7px 14px",
          }}>
            <span style={{ fontSize: "0.73rem", color: accentColor, fontWeight: 600 }}>Tap for abstract</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.uid}/`} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ fontSize: "0.7rem", color: accentColor, border: `1px solid ${accentColor}40`, borderRadius: 4, padding: "5px 10px", textDecoration: "none", fontWeight: 600 }}>
              PubMed ↗
            </a>
            {doi && (
              <a href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ fontSize: "0.7rem", color: "#7a9ab8", border: "1px solid rgba(122,154,184,0.3)", borderRadius: 4, padding: "5px 10px", textDecoration: "none" }}>
                DOI ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Algorithm Engine ─────────────────────────────────────────────────────────
async function fetchAndRankBatch(profile, usedPmids = new Set()) {
  const queries = [];

  // 1. Personalized query based on interest profile
  const personalQ = buildPersonalizedQuery(profile);
  if (personalQ) queries.push({ q: personalQ, weight: 2.0, label: "for_you" });

  // 2. Top seed topic (cold start or variety)
  queries.push({ q: SEED_TOPICS[0].query, weight: 1.0, label: "trending" });

  // 3. Mix in a random topic for serendipity
  const randTopic = SEED_TOPICS[1 + Math.floor(Math.random() * (SEED_TOPICS.length - 1))];
  queries.push({ q: randTopic.query, weight: 0.6, label: "discover" });

  // Fetch from all queries in parallel
  const results = await Promise.all(
    queries.map(async ({ q, weight, label }) => {
      try {
        const { ids } = await searchPMIDs(q, 0, PAGE_SIZE);
        const summaries = await fetchSummaries(ids.filter(id => !usedPmids.has(id)));
        return summaries.map(s => ({ ...s, _sourceWeight: weight, _label: label }));
      } catch { return []; }
    })
  );

  // Merge, dedupe
  const seen = new Set();
  const merged = results.flat().filter(p => {
    if (!p?.uid || seen.has(p.uid) || usedPmids.has(p.uid)) return false;
    seen.add(p.uid);
    return true;
  });

  // Fetch Altmetric scores in parallel (best-effort)
  const altScores = {};
  await Promise.allSettled(
    merged.slice(0, 20).map(async p => {
      const doi = parseDoi(p.elocationid);
      if (doi) altScores[p.uid] = await fetchAltmetric(doi);
    })
  );

  // Score and rank
  const scored = merged.map(p => {
    const profileSc = scoreForProfile(p, profile);
    const altSc = (altScores[p.uid] || 0);
    const recency = p.pubdate?.includes("2024") || p.pubdate?.includes("2025") ? 5 : 0;
    const total = (profileSc * 3) + (altSc * 0.15) + recency + (p._sourceWeight * 2);
    return { ...p, _altScore: altScores[p.uid] || null, _profileScore: profileSc, _totalScore: total };
  });

  scored.sort((a, b) => b._totalScore - a._totalScore);
  return scored;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function PubScroll() {
  const [papers, setPapers] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [profile, setProfile] = useState(loadProfile);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const [manualQuery, setManualQuery] = useState(null);
  const [showProfileHint, setShowProfileHint] = useState(false);
  const [isSnapping, setIsSnapping] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const usedPmids = useRef(new Set());
  const touchStartY = useRef(null);
  const touchStartX = useRef(null);
  const isDragging = useRef(false);
  const dragAxis = useRef(null); // "vertical" | "horizontal" | null
  const cardArriveTime = useRef(Date.now());
  const containerRef = useRef(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const loadBatch = useCallback(async (query = null) => {
    setLoadingMore(true);
    try {
      let batch;
      if (query) {
        const { ids } = await searchPMIDs(query, 0, PAGE_SIZE);
        const summaries = await fetchSummaries(ids);
        const altScores = {};
        await Promise.allSettled(summaries.slice(0, 10).map(async p => {
          const doi = parseDoi(p.elocationid);
          if (doi) altScores[p.uid] = await fetchAltmetric(doi);
        }));
        batch = summaries.map(p => ({ ...p, _altScore: altScores[p.uid] || null, _profileScore: 0, _totalScore: 0 }));
      } else {
        batch = await fetchAndRankBatch(profileRef.current, usedPmids.current);
      }
      batch.forEach(p => usedPmids.current.add(p.uid));
      setPapers(prev => [...prev, ...batch]);
    } catch (e) { console.error(e); }
    setLoadingMore(false);
    setLoading(false);
  }, []);

  useEffect(() => { loadBatch(); }, []);

  // Load more when near end
  useEffect(() => {
    if (papers.length > 0 && currentIndex >= papers.length - 4 && !loadingMore) {
      loadBatch(manualQuery);
    }
  }, [currentIndex, papers.length]);

  // Save profile whenever it changes
  useEffect(() => { saveProfile(profile); }, [profile]);

  const recordEngagement = useCallback((paper, type) => {
    setProfile(prev => updateProfile(prev, paper, type));
    if (type === "read") setShowProfileHint(p => p.totalSeen % 5 === 0);
  }, []);

  const goNext = useCallback(() => {
    const paper = papers[currentIndex];
    if (paper) {
      const secs = (Date.now() - cardArriveTime.current) / 1000;
      recordEngagement(paper, secs < 2 ? "skip" : "view");
    }
    setCurrentIndex(i => Math.min(i + 1, papers.length - 1));
    cardArriveTime.current = Date.now();
  }, [papers, currentIndex, recordEngagement]);

  const goPrev = useCallback(() => {
    setCurrentIndex(i => Math.max(i - 1, 0));
    cardArriveTime.current = Date.now();
  }, []);

  // Touch — TikTok snap style
  const onTouchStart = e => {
    if (selectedPaper || isSnapping) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
    isDragging.current = true;
    dragAxis.current = null;
  };
  const onTouchMove = e => {
    if (!isDragging.current || selectedPaper) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    const dx = e.touches[0].clientX - touchStartX.current;
    // Lock axis on first significant movement
    if (!dragAxis.current) {
      if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        dragAxis.current = Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
      }
    }
    if (dragAxis.current === "vertical") {
      e.preventDefault();
      // Resist at edges
      const atTop = currentIndex === 0 && dy > 0;
      const atBottom = currentIndex >= papers.length - 1 && dy < 0;
      const resistance = (atTop || atBottom) ? 0.15 : 1;
      setDragOffset(dy * resistance);
    }
  };
  const onTouchEnd = e => {
    if (!isDragging.current || selectedPaper) return;
    isDragging.current = false;
    dragAxis.current = null;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    const velocity = Math.abs(dy) / Math.max(1, e.timeStamp - (touchStartY._startTime || e.timeStamp));
    const threshold = window.innerHeight * 0.2; // 20% of screen height
    setDragOffset(0);
    if (Math.abs(dy) > threshold || Math.abs(dy) > 60) {
      setIsSnapping(true);
      if (dy < 0) goNext(); else goPrev();
      setTimeout(() => setIsSnapping(false), 400);
    }
  };

  // Keyboard + wheel
  useEffect(() => {
    const kh = e => {
      if (e.key === "ArrowDown") goNext();
      if (e.key === "ArrowUp") goPrev();
      if (e.key === "Escape") { setSelectedPaper(null); setShowMenu(false); setShowSearch(false); }
    };
    window.addEventListener("keydown", kh);
    return () => window.removeEventListener("keydown", kh);
  }, [goNext, goPrev]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let last = 0;
    const wh = e => {
      e.preventDefault();
      const now = Date.now();
      if (now - last < 550) return;
      last = now;
      if (e.deltaY > 0) goNext(); else goPrev();
    };
    el.addEventListener("wheel", wh, { passive: false });
    return () => el.removeEventListener("wheel", wh);
  }, [goNext, goPrev]);

  const handleSearch = () => {
    const q = inputVal.trim();
    if (!q) return;
    setManualQuery(q);
    setShowSearch(false);
    setShowMenu(false);
    setPapers([]);
    usedPmids.current = new Set();
    setCurrentIndex(0);
    setLoading(true);
    loadBatch(q);
  };

  const handleTopicClick = (topic) => {
    setManualQuery(topic.query);
    setShowMenu(false);
    setPapers([]);
    usedPmids.current = new Set();
    setCurrentIndex(0);
    setLoading(true);
    loadBatch(topic.query);
  };

  const resetToAlgo = () => {
    setManualQuery(null);
    setShowMenu(false);
    setPapers([]);
    usedPmids.current = new Set();
    setCurrentIndex(0);
    setLoading(true);
    loadBatch(null);
  };

  const currentPaper = papers[currentIndex];
  const isAlgoMode = !manualQuery;

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#061428", position: "fixed", inset: 0, touchAction: "none" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { overflow: hidden; height: 100%; width: 100%; overscroll-behavior: none; }
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; -ms-overflow-style: none; }
        @keyframes fadeIn { from{opacity:0}to{opacity:1} }
        @keyframes slideUp { from{transform:translateY(100%)}to{transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes cardIn { from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.5} }
        a:hover { opacity: 0.8; }
        button { cursor: pointer; }
      `}</style>

      {/* TikTok snap feed — render current + adjacent cards in a vertical stack */}
      <div
        ref={containerRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: "absolute", inset: 0, overflow: "hidden", touchAction: "none",
        }}
      >
        {loading ? (
          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #0d2a4a, #061428)", gap: 16 }}>
            <div style={{ width: 38, height: 38, border: "3px solid #1a3a5a", borderTopColor: "#4a9edd", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ color: "#4a9edd", fontFamily: "Georgia, serif", fontSize: "0.9rem" }}>
              {isAlgoMode ? "Building your feed…" : "Loading papers…"}
            </span>
          </div>
        ) : papers.length === 0 ? (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#4a9edd", fontFamily: "Georgia, serif", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: "2rem" }}>∅</span>
            <span>No papers found</span>
          </div>
        ) : (
          // Stack: prev card above, current in view, next card below
          // Offset entire stack by dragOffset so adjacent cards peek during drag
          <div style={{
            position: "absolute", inset: 0,
            transform: `translateY(calc(${-currentIndex * 100}% + ${dragOffset}px))`,
            transition: isDragging.current ? "none" : "transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)",
            willChange: "transform",
          }}>
            {papers.map((paper, i) => {
              // Only render cards near current index for perf
              if (Math.abs(i - currentIndex) > 2) return null;
              return (
                <div key={paper.uid} style={{
                  position: "absolute", top: `${i * 100}%`,
                  width: "100%", height: "100%",
                }}>
                  <PaperCard
                    paper={paper}
                    altScore={paper._altScore}
                    onTap={i === currentIndex ? () => {
                      recordEngagement(paper, "read");
                      setSelectedPaper(paper);
                    } : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>





      {/* Top banner — PubScroll logo + controls */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 20,
        paddingTop: "env(safe-area-inset-top, 0px)",
        background: "linear-gradient(180deg, rgba(4,10,20,0.97) 0%, rgba(4,10,20,0.85) 75%, transparent 100%)",
        pointerEvents: "none",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px 20px", pointerEvents: "auto",
        }}>
          {/* Logo */}
          <span style={{ fontFamily: "Georgia, serif", fontSize: "1.15rem", fontWeight: 700, color: "#4a9edd", letterSpacing: "-0.01em" }}>
            PubScroll
          </span>
          {/* Controls */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setShowSearch(s => !s); setShowMenu(false); }}
              style={{ background: "rgba(6,20,40,0.85)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 6, color: "#4a9edd", width: 34, height: 34, fontSize: "0.95rem", display: "flex", alignItems: "center", justifyContent: "center" }}>🔍</button>
            <button onClick={() => { setShowMenu(s => !s); setShowSearch(false); }}
              style={{ background: "rgba(6,20,40,0.85)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 6, color: "#4a9edd", padding: "0 12px", height: 34, fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.03em" }}>
              {isAlgoMode ? "✦ For You" : "Browse"} ▾
            </button>
          </div>
        </div>
      </div>

      {/* Search */}
      {showSearch && (
        <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 58px)", right: 14, left: 14, zIndex: 30, background: "rgba(6,18,38,0.98)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 8, padding: 14, animation: "fadeIn 0.15s ease", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input autoFocus value={inputVal} onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              placeholder="Search any topic…"
              style={{ flex: 1, background: "#061428", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 4, padding: "8px 12px", color: "#e8f4ff", fontSize: "0.9rem", outline: "none", fontFamily: "Georgia, serif" }}
            />
            <button onClick={handleSearch} style={{ background: "#1a6bb5", color: "#fff", border: "none", borderRadius: 4, padding: "8px 16px", fontWeight: 700, fontSize: "0.85rem" }}>Go</button>
          </div>
        </div>
      )}

      {/* Menu */}
      {showMenu && (
        <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 58px)", right: 14, zIndex: 30, background: "rgba(6,18,38,0.98)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 8, padding: 6, animation: "fadeIn 0.15s ease", minWidth: 200, boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
          <button onClick={resetToAlgo} style={{ width: "100%", background: isAlgoMode ? "rgba(74,158,221,0.15)" : "transparent", border: "none", color: isAlgoMode ? "#4a9edd" : "#7a9ab8", padding: "9px 14px", borderRadius: 4, fontSize: "0.82rem", textAlign: "left", fontWeight: isAlgoMode ? 700 : 400 }}>
            ✦ For You (algo)
          </button>
          <div style={{ height: 1, background: "rgba(74,158,221,0.1)", margin: "4px 8px" }} />
          {SEED_TOPICS.map((t, i) => (
            <button key={i} onClick={() => handleTopicClick(t)} style={{ width: "100%", background: "transparent", border: "none", color: "#7a9ab8", padding: "9px 14px", borderRadius: 4, fontSize: "0.82rem", textAlign: "left" }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Abstract */}
      {selectedPaper && (
        <AbstractOverlay
          paper={selectedPaper}
          altScore={selectedPaper._altScore}
          onClose={() => setSelectedPaper(null)}
          onEngagement={(type) => recordEngagement(selectedPaper, type)}
        />
      )}
    </div>
  );
}
