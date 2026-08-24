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

    // Europe PMC - Medical focused, free, no key needed
    if (enableEuropePMC !== false) {
      promises.push(
        (async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/SEARCH?query=' + 
              encodeURIComponent(cleanQuery) + 
              '&pageSize=10&format=json&resultType=core&sort_date=y';
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
                source: 'Europe PMC'
              };
            }).filter(p => p.directUrl && p.title !== 'Unknown Title');
          } catch (e) { return []; }
        })()
      );
    }

    // PubMed - Medical focused, requires API key for higher limits
    if (enablePubMed && pubmedApiKey) {
      promises.push(
        (async () => {
          try {
            let searchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=' + 
              encodeURIComponent(cleanQuery) + '&retmax=10&retmode=json&sort=date';
            if (pubmedApiKey) searchUrl += '&api_key=' + pubmedApiKey;
            const searchRes = await fetch(searchUrl);
            if (!searchRes.ok) return [];
            const searchData = await searchRes.json();
            if (!searchData.esearchresult?.idlist?.length) return [];
            const ids = searchData.esearchresult.idlist.slice(0, 10).join(',');
            let summaryUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=' + ids + '&retmode=json';
            if (pubmedApiKey) summaryUrl += '&api_key=' + pubmedApiKey;
            const summaryRes = await fetch(summaryUrl);
            if (!summaryRes.ok) return [];
            const summaryData = await summaryRes.json();
            const papers = [];
            for (const id of searchData.esearchresult.idlist.slice(0, 10)) {
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
                  source: 'PubMed'
                });
              }
            }
            return papers;
          } catch (e) { return []; }
        })()
      );
    }

    // OpenAlex - Filtered for MEDICINE only, free, no key needed
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          // C71924100 = Medicine concept in OpenAlex
          const url = 'https://api.openalex.org/works?search=' + 
            encodeURIComponent(cleanQuery) + 
            '&filter=concepts.id:C71924100&per-page=10&select=id,display_name,authorships,publication_year,doi,primary_location,open_access';
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timeout);
          if (!r.ok) return [];
          const data = await r.json();
          if (!data.results || !Array.isArray(data.results)) return [];
          return data.results.map(paper => {
            const doi = validateDoi(paper.doi);
            // Try to get the best URL
            let directUrl = null;
            if (paper.primary_location && paper.primary_location.landing_page_url) {
              directUrl = paper.primary_location.landing_page_url;
            } else if (doi) {
              directUrl = 'https://doi.org/' + doi;
            } else if (paper.id) {
              directUrl = paper.id;
            }
            // Get authors
            let authors = 'Unknown';
            if (paper.authorships && paper.authorships.length > 0) {
              authors = paper.authorships.slice(0, 5).map(a => 
                a.author ? a.author.display_name : 'Unknown'
              ).join(', ');
            }
            // Get journal
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
              source: 'OpenAlex Medicine'
            };
          }).filter(p => p.directUrl && p.title !== 'Unknown Title');
        } catch (e) { return []; }
      })()
    );

    // Semantic Scholar - Medical & academic, free
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + 
            encodeURIComponent(cleanQuery) + 
            '&fields=title,authors,year,externalIds,abstract,journal,publicationDate,paperId&limit=10';
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
              source: 'Semantic Scholar'
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

    const seen = new Set();
    const unique = [];
    for (const paper of results) {
      const key = paper.doi || paper.pmid || (paper.title + '|' + paper.year);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(paper);
      }
    }

    unique.sort((a, b) => {
      const yA = parseInt(a.year) || 0;
      const yB = parseInt(b.year) || 0;
      return yB - yA;
    });

    res.status(200).json({ sources: unique.slice(0, 15) });
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
