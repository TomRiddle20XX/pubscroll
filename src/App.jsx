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
function PaperCard({ paper, altScore, profileScore, onTap }) {
  const doi = parseDoi(paper.elocationid);
  const journal = paper.fulljournalname || paper.source || "";
  const year = (paper.pubdate || "").substring(0, 4);
  const pubType = paper.pubtype?.find(t =>
    ["Meta-Analysis","Systematic Review","Clinical Trial","Randomized Controlled Trial","Review"].includes(t)
  );

  // Hue shift based on altmetric buzz
  const buzzy = altScore && altScore > 50;
  const bgGrad = buzzy
    ? "linear-gradient(160deg, #1a2a0a 0%, #0f1f0a 50%, #061208 100%)"
    : "linear-gradient(160deg, #0d2a4a 0%, #0a1f3a 50%, #061428 100%)";
  const accentColor = buzzy ? "#7ec850" : "#4a9edd";

  return (
    <div onClick={onTap} style={{
      width: "100%", height: "100%",
      background: bgGrad,
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
      cursor: "pointer", userSelect: "none", position: "relative", overflow: "hidden",
    }}>
      {/* Grid texture */}
      <div style={{
        position: "absolute", inset: 0, opacity: 0.035,
        backgroundImage: `linear-gradient(${accentColor} 1px, transparent 1px), linear-gradient(90deg, ${accentColor} 1px, transparent 1px)`,
        backgroundSize: "40px 40px"
      }} />

      {/* PMID watermark */}
      <div style={{
        position: "absolute", top: "42%", left: "50%",
        transform: "translate(-50%, -50%)",
        fontSize: "clamp(70px, 22vw, 140px)", fontWeight: 900,
        color: `${accentColor}08`, fontFamily: "Georgia, serif",
        letterSpacing: "-0.05em", userSelect: "none", whiteSpace: "nowrap", pointerEvents: "none"
      }}>{paper.uid}</div>

      {/* Top bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        background: "linear-gradient(180deg, rgba(6,14,26,0.96) 0%, transparent 100%)",
        padding: "16px 20px 50px",
        display: "flex", alignItems: "center", justifyContent: "space-between"
      }}>
        <span style={{ fontFamily: "Georgia, serif", fontSize: "1.05rem", fontWeight: 700, color: accentColor }}>
          PubScroll
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {altScore && altScore > 20 && (
            <span style={{
              fontSize: "0.6rem", fontWeight: 800, padding: "2px 8px",
              background: buzzy ? "rgba(126,200,80,0.15)" : "rgba(245,158,11,0.12)",
              color: buzzy ? "#7ec850" : "#f59e0b",
              border: `1px solid ${buzzy ? "rgba(126,200,80,0.35)" : "rgba(245,158,11,0.3)"}`,
              borderRadius: 20, letterSpacing: "0.05em", textTransform: "uppercase"
            }}>⚡ {Math.round(altScore)}</span>
          )}
          {pubType && (
            <span style={{
              fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.08em",
              textTransform: "uppercase", padding: "2px 8px",
              background: `${accentColor}18`, color: accentColor,
              border: `1px solid ${accentColor}40`, borderRadius: 3
            }}>{pubType}</span>
          )}
        </div>
      </div>

      {/* Bottom content */}
      <div style={{
        padding: "60px 24px 0",
        background: "linear-gradient(0deg, rgba(4,10,20,0.99) 0%, rgba(4,10,20,0.85) 65%, transparent 100%)",
        paddingBottom: 0,
      }}>
        {/* Journal + year */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.67rem", color: accentColor, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {journal.length > 42 ? journal.substring(0, 42) + "…" : journal}
          </span>
          {year && <span style={{ fontSize: "0.67rem", color: "#5a7a99", fontFamily: "monospace" }}>· {year}</span>}
        </div>

        {/* Title */}
        <h2 style={{
          fontSize: "clamp(1rem, 3.8vw, 1.25rem)", fontWeight: 700, lineHeight: 1.5,
          color: "#e8f4ff", marginBottom: 14,
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
            <span style={{ fontSize: "0.73rem", color: accentColor, fontWeight: 600 }}>Tap to read abstract</span>
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

        <div style={{ textAlign: "center", marginTop: 16, paddingBottom: 28, color: "#2a4a66", fontSize: "0.65rem", letterSpacing: "0.06em" }}>
          ↕ swipe
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

  const usedPmids = useRef(new Set());
  const touchStartY = useRef(null);
  const touchStartX = useRef(null);
  const isDragging = useRef(false);
  const cardArriveTime = useRef(Date.now());
  const [dragY, setDragY] = useState(0);
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

  // Touch
  const onTouchStart = e => {
    if (selectedPaper) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
    isDragging.current = true;
  };
  const onTouchMove = e => {
    if (!isDragging.current || selectedPaper) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    const dx = e.touches[0].clientX - touchStartX.current;
    if (Math.abs(dy) > Math.abs(dx)) { e.preventDefault(); setDragY(dy * 0.35); }
  };
  const onTouchEnd = e => {
    if (!isDragging.current || selectedPaper) return;
    isDragging.current = false;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    setDragY(0);
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 45) {
      if (dy < 0) goNext(); else goPrev();
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
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#061428" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from{opacity:0}to{opacity:1} }
        @keyframes slideUp { from{transform:translateY(100%)}to{transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes cardIn { from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.5} }
        body { overflow: hidden; }
        a:hover { opacity: 0.8; }
        button { cursor: pointer; }
      `}</style>

      {/* Card */}
      <div ref={containerRef}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ width: "100%", height: "100%", transform: `translateY(${dragY}px)`, transition: isDragging.current ? "none" : "transform 0.22s ease" }}
      >
        {loading ? (
          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #0d2a4a, #061428)", gap: 16 }}>
            <div style={{ width: 38, height: 38, border: "3px solid #1a3a5a", borderTopColor: "#4a9edd", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ color: "#4a9edd", fontFamily: "Georgia, serif", fontSize: "0.9rem" }}>
              {isAlgoMode ? "Building your feed…" : "Loading papers…"}
            </span>
          </div>
        ) : currentPaper ? (
          <div key={`card-${currentIndex}`} style={{ width: "100%", height: "100%", animation: "cardIn 0.28s ease" }}>
            <PaperCard
              paper={currentPaper}
              altScore={currentPaper._altScore}
              profileScore={currentPaper._profileScore}
              onTap={() => {
                recordEngagement(currentPaper, "read");
                setSelectedPaper(currentPaper);
              }}
            />
          </div>
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#4a9edd", fontFamily: "Georgia, serif", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: "2rem" }}>∅</span>
            <span>No papers found</span>
          </div>
        )}
      </div>

      {/* Progress dots */}
      {papers.length > 0 && (
        <div style={{ position: "fixed", right: 10, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 4, zIndex: 10 }}>
          {papers.slice(Math.max(0, currentIndex - 4), currentIndex + 6).map((_, i) => {
            const ri = Math.max(0, currentIndex - 4) + i;
            return <div key={ri} style={{ width: ri === currentIndex ? 4 : 3, height: ri === currentIndex ? 20 : 5, borderRadius: 2, background: ri === currentIndex ? "#4a9edd" : "rgba(74,158,221,0.2)", transition: "all 0.2s" }} />;
          })}
        </div>
      )}

      {/* Counter + algo badge */}
      <div style={{ position: "fixed", left: 14, bottom: 26, zIndex: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        {papers.length > 0 && (
          <span style={{ fontFamily: "monospace", fontSize: "0.62rem", color: "rgba(74,158,221,0.4)" }}>
            {currentIndex + 1} loaded
          </span>
        )}
        {isAlgoMode && (
          <span style={{ fontSize: "0.58rem", fontWeight: 700, color: "rgba(74,158,221,0.35)", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "monospace" }}>
            ✦ algo feed
          </span>
        )}
        {loadingMore && (
          <span style={{ fontSize: "0.6rem", color: "rgba(74,158,221,0.4)", fontFamily: "monospace", animation: "pulse 1.2s ease infinite" }}>fetching…</span>
        )}
      </div>

      {/* Top controls */}
      <div style={{ position: "fixed", top: 14, right: 14, zIndex: 20, display: "flex", gap: 8 }}>
        <button onClick={() => { setShowSearch(s => !s); setShowMenu(false); }}
          style={{ background: "rgba(6,20,40,0.9)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 6, color: "#4a9edd", width: 36, height: 36, fontSize: "1rem", display: "flex", alignItems: "center", justifyContent: "center" }}>🔍</button>
        <button onClick={() => { setShowMenu(s => !s); setShowSearch(false); }}
          style={{ background: "rgba(6,20,40,0.9)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 6, color: "#4a9edd", padding: "0 12px", height: 36, fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.03em" }}>
          {isAlgoMode ? "✦ For You" : "Browse"} ▾
        </button>
      </div>

      {/* Search */}
      {showSearch && (
        <div style={{ position: "fixed", top: 58, right: 14, left: 14, zIndex: 30, background: "rgba(6,18,38,0.98)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 8, padding: 14, animation: "fadeIn 0.15s ease", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
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
        <div style={{ position: "fixed", top: 58, right: 14, zIndex: 30, background: "rgba(6,18,38,0.98)", border: "1px solid rgba(74,158,221,0.3)", borderRadius: 8, padding: 6, animation: "fadeIn 0.15s ease", minWidth: 200, boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
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