export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { query, enableEuropePMC, enablePubMed, pubmedApiKey } = req.body;
    if (!query || query.trim().length < 2) {
      res.status(400).json({ error: 'Query too short' });
      return;
    }

    const cleanQuery = query
      .replace(/[^a-zA-Z0-9\s\-\+\.\,\(\)\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);

    const promises = [];

    // 1. PubMed - HIGHEST PRIORITY (most trusted medical source)
    if (enablePubMed && pubmedApiKey) {
      promises.push(
        (async () => {
          try {
            let searchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=' + 
              encodeURIComponent(cleanQuery) + '&retmax=5&retmode=json&sort=date';
            if (pubmedApiKey) searchUrl += '&api_key=' + pubmedApiKey;
            const searchRes = await fetch(searchUrl);
            if (!searchRes.ok) return [];
            const searchData = await searchRes.json();
            if (!searchData.esearchresult?.idlist?.length) return [];
            const ids = searchData.esearchresult.idlist.slice(0, 5).join(',');
            let summaryUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=' + ids + '&retmode=json';
            if (pubmedApiKey) summaryUrl += '&api_key=' + pubmedApiKey;
            const summaryRes = await fetch(summaryUrl);
            if (!summaryRes.ok) return [];
            const summaryData = await summaryRes.json();
            const papers = [];
            for (const id of searchData.esearchresult.idlist.slice(0, 5)) {
              const article = summaryData.result?.[id];
              if (article?.title) {
                const doi = validateDoi(article.elocationid || article.doi);
                const pmid = validatePmid(id);
                const directUrl = pmid ? 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/' : (doi ? 'https://doi.org/' + doi : null);
                papers.push({
                  title: article.title,
                  authors: article.authors ? article.authors.map(a => a.name).join(', ') : 'Unknown',
                  journal: article.fulljournalname || article.source || 'Unknown',
                  year: article.pubdate ? article.pubdate.split(' ')[0] : 'Unknown',
                  doi, pmid, abstract: '', 
                  url: directUrl,
                  directUrl: directUrl,
                  source: 'PubMed',
                  priority: 1
                });
              }
            }
            return papers;
          } catch (e) { return []; }
        })()
      );
    }

    // 2. Europe PMC - HIGH PRIORITY (free, medical focused)
    if (enableEuropePMC !== false) {
      promises.push(
        (async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/SEARCH?query=' + 
              encodeURIComponent(cleanQuery) + 
              '&pageSize=5&format=json&resultType=core&sort_date=y';
            const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
            clearTimeout(timeout);
            if (!r.ok) return [];
            const data = await r.json();
            if (!data.resultList || !Array.isArray(data.resultList.result)) return [];
            return data.resultList.result.map(paper => {
              const doi = validateDoi(paper.doi);
              const pmid = validatePmid(paper.pmid);
              const pmcid = paper.pmcid ? 'PMC' + paper.pmcid : null;
              let directUrl = null;
              if (pmcid) directUrl = 'https://europepmc.org/article/' + pmcid;
              else if (pmid) directUrl = 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/';
              else if (doi) directUrl = 'https://doi.org/' + doi;
              return {
                title: paper.title || 'Unknown Title',
                authors: paper.authorString || (paper.authorList ? paper.authorList.author.map(a => a.fullName || a.lastName).join(', ') : 'Unknown'),
                journal: paper.journalTitle || paper.bookTitle || 'Unknown Journal',
                year: paper.pubYear || (paper.firstPublicationDate ? paper.firstPublicationDate.split('-')[0] : 'Unknown'),
                doi, pmid, pmcid, abstract: paper.abstractText || '', 
                url: directUrl,
                directUrl: directUrl,
                source: 'Europe PMC',
                priority: 2
              };
            }).filter(p => p.directUrl && p.title !== 'Unknown Title');
          } catch (e) { return []; }
        })()
      );
    }

    // 3. Semantic Scholar - MEDIUM PRIORITY (academic, medical)
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + 
            encodeURIComponent(cleanQuery) + 
            '&fields=title,authors,year,externalIds,abstract,journal,publicationDate,paperId&limit=5';
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timeout);
          if (!r.ok) return [];
          const data = await r.json();
          if (!data.data || !Array.isArray(data.data)) return [];
          return data.data.map(paper => {
            const doi = validateDoi(paper.externalIds?.DOI);
            const pmid = validatePmid(paper.externalIds?.PubMed);
            const directUrl = paper.paperId ? 'https://www.semanticscholar.org/paper/' + paper.paperId : null;
            return {
              title: paper.title || 'Unknown Title',
              authors: paper.authors ? paper.authors.map(a => a.name).join(', ') : 'Unknown',
              journal: paper.journal ? (paper.journal.name || paper.journal) : 'Unknown',
              year: paper.year || (paper.publicationDate ? paper.publicationDate.split('-')[0] : 'Unknown'),
              doi, pmid, abstract: paper.abstract || '', 
              url: directUrl,
              directUrl: directUrl,
              source: 'Semantic Scholar',
              priority: 3
            };
          }).filter(p => p.directUrl && p.title !== 'Unknown Title');
        } catch (e) { return []; }
      })()
    );

    // 4. OpenAlex Medicine - LOWER PRIORITY (backup)
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const url = 'https://api.openalex.org/works?search=' + 
            encodeURIComponent(cleanQuery) + 
            '&filter=concepts.id:C71924100&per-page=5&select=id,display_name,authorships,publication_year,doi,primary_location,open_access';
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timeout);
          if (!r.ok) return [];
          const data = await r.json();
          if (!data.results || !Array.isArray(data.results)) return [];
          return data.results.map(paper => {
            const doi = validateDoi(paper.doi);
            let directUrl = null;
            if (paper.primary_location && paper.primary_location.landing_page_url) {
              directUrl = paper.primary_location.landing_page_url;
            } else if (doi) {
              directUrl = 'https://doi.org/' + doi;
            } else if (paper.id) {
              directUrl = paper.id;
            }
            let authors = 'Unknown';
            if (paper.authorships && paper.authorships.length > 0) {
              authors = paper.authorships.slice(0, 5).map(a => 
                a.author ? a.author.display_name : 'Unknown'
              ).join(', ');
            }
            let journal = 'Unknown Journal';
            if (paper.primary_location && paper.primary_location.source && paper.primary_location.source.display_name) {
              journal = paper.primary_location.source.display_name;
            }
            return {
              title: paper.display_name || 'Unknown Title',
              authors: authors,
              journal: journal,
              year: paper.publication_year || 'Unknown',
              doi: doi,
              pmid: null,
              abstract: '', 
              url: directUrl,
              directUrl: directUrl,
              source: 'OpenAlex Medicine',
              priority: 4
            };
          }).filter(p => p.directUrl && p.title !== 'Unknown Title');
        } catch (e) { return []; }
      })()
    );

    const allResults = await Promise.allSettled(promises);
    const results = [];
    allResults.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) results.push(...r.value);
    });

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const paper of results) {
      const key = paper.doi || paper.pmid || (paper.title + '|' + paper.year);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(paper);
      }
    }

    // Weighted scoring: balances TRUST + RECENCY
    // Trust score: PubMed(4) > Europe PMC(3) > Semantic Scholar(2) > OpenAlex(1)
    // Recency score: 2024(10) > 2023(9) > 2022(8) ... 2015(1) < 2015(0)
    const currentYear = new Date().getFullYear();

    unique.forEach(paper => {
      const year = parseInt(paper.year) || 0;
      const priority = paper.priority || 5;

      // Trust weight (higher = more trusted)
      const trustScore = priority === 1 ? 40 :  // PubMed
                        priority === 2 ? 30 :  // Europe PMC
                        priority === 3 ? 20 :  // Semantic Scholar
                        priority === 4 ? 10 : 0; // OpenAlex

      // Recency weight (newer = higher score, max 50 points)
      let recencyScore = 0;
      if (year >= currentYear - 1) recencyScore = 50;        // 2024-2025
      else if (year >= currentYear - 2) recencyScore = 45;   // 2023
      else if (year >= currentYear - 3) recencyScore = 40;   // 2022
      else if (year >= currentYear - 4) recencyScore = 35;   // 2021
      else if (year >= currentYear - 5) recencyScore = 30;   // 2020
      else if (year >= currentYear - 7) recencyScore = 20;   // 2018-2019
      else if (year >= currentYear - 10) recencyScore = 10;  // 2015-2017
      else if (year > 2000) recencyScore = 5;                // 2001-2014

      // Total score (max 90)
      paper.score = trustScore + recencyScore;
    });

    // Sort by score (highest first)
    unique.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Take top 12, ensuring at least some diversity
    // But prioritize highest scores (most trusted + most recent)
    const final = [];
    const sourceCounts = {};
    const maxPerSource = 4;  // Allow up to 4 from best source if they score high
    const minPerSource = 1;  // Ensure at least 1 from each source if available and decent score

    // First pass: ensure minimum diversity (1 from each source with score > 20)
    const sourcePool = {};
    unique.forEach(p => {
      const src = p.source || 'Unknown';
      if (!sourcePool[src]) sourcePool[src] = [];
      sourcePool[src].push(p);
    });

    // Add 1 from each source (highest scoring from that source)
    Object.keys(sourcePool).forEach(src => {
      const best = sourcePool[src][0]; // Already sorted by score
      if (best && best.score > 15 && final.length < 12) {
        final.push(best);
        sourceCounts[src] = 1;
      }
    });

    // Second pass: fill remaining slots with highest scoring papers
    for (const paper of unique) {
      const src = paper.source || 'Unknown';
      if (!sourceCounts[src]) sourceCounts[src] = 0;
      // Check if already added
      const alreadyAdded = final.some(f => 
        (f.doi && f.doi === paper.doi) || 
        (f.pmid && f.pmid === paper.pmid) ||
        (f.title === paper.title && f.year === paper.year)
      );
      if (!alreadyAdded && sourceCounts[src] < maxPerSource && final.length < 12) {
        final.push(paper);
        sourceCounts[src]++;
      }
    }

    res.status(200).json({ sources: final });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function validateDoi(doi) {
  if (!doi) return null;
  const clean = String(doi).trim().replace(/^doi:/i, '').replace(/^https?:\/\/doi\.org\//i, '');
  if (clean.length < 5) return null;
  if (!/^10\.\d{4,}\/.*/.test(clean)) return null;
  return clean;
}

function validatePmid(pmid) {
  if (!pmid) return null;
  const clean = String(pmid).trim().replace(/\D/g, '');
  if (clean.length < 3 || clean.length > 10) return null;
  return clean;
}
