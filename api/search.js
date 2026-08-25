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

    // Extract key medical terms from the query for relevance scoring
    const queryLower = query.toLowerCase();
    const queryTerms = extractMedicalTerms(query);

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
              encodeURIComponent(cleanQuery) + '&retmax=10&retmode=json&sort=relevance';
            if (pubmedApiKey) searchUrl += '&api_key=' + pubmedApiKey;
            const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(12000) });
            if (!searchRes.ok) return [];
            const searchData = await searchRes.json();
            if (!searchData.esearchresult?.idlist?.length) return [];
            const ids = searchData.esearchresult.idlist.slice(0, 10).join(',');

            // Fetch abstracts using efetch
            let fetchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=' + ids + '&retmode=xml';
            if (pubmedApiKey) fetchUrl += '&api_key=' + pubmedApiKey;
            const fetchRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
            if (!fetchRes.ok) return [];
            const xmlText = await fetchRes.text();

            // Parse XML to get abstracts
            const papers = [];
            const articles = xmlText.split('<PubmedArticle>');
            for (let i = 1; i < articles.length; i++) {
              const article = articles[i];
              const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);
              const titleMatch = article.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
              const abstractMatch = article.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
              const journalMatch = article.match(/<Title>([\s\S]*?)<\/Title>/);
              const yearMatch = article.match(/<PubDate>.*?<Year>(\d+)<\/Year>.*?<\/PubDate>/);
              const doiMatch = article.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/);

              if (pmidMatch && titleMatch) {
                const pmid = pmidMatch[1];
                const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
                const abstract = abstractMatch ? abstractMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                const journal = journalMatch ? journalMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown';
                const year = yearMatch ? yearMatch[1] : 'Unknown';
                const doi = doiMatch ? validateDoi(doiMatch[1]) : null;
                const directUrl = 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/';

                papers.push({
                  title, abstract, journal, year, doi, pmid,
                  url: directUrl,
                  directUrl,
                  source: 'PubMed',
                  priority: 1
                });
              }
            }
            return papers;
          } catch (e) { console.error('PubMed error:', e.message); return []; }
        })()
      );
    }

    // 2. Europe PMC - HIGH PRIORITY (free, medical focused)
    if (enableEuropePMC !== false) {
      promises.push(
        (async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);
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
                abstract: paper.abstractText || '',
                authors: paper.authorString || (paper.authorList ? paper.authorList.author.map(a => a.fullName || a.lastName).join(', ') : 'Unknown'),
                journal: paper.journalTitle || paper.bookTitle || 'Unknown Journal',
                year: paper.pubYear || (paper.firstPublicationDate ? paper.firstPublicationDate.split('-')[0] : 'Unknown'),
                doi, pmid, pmcid,
                url: directUrl,
                directUrl,
                source: 'Europe PMC',
                priority: 2
              };
            }).filter(p => p.directUrl && p.title !== 'Unknown Title');
          } catch (e) { console.error('Europe PMC error:', e.message); return []; }
        })()
      );
    }

    // 3. Semantic Scholar - MEDIUM PRIORITY (academic, medical)
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
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
              abstract: paper.abstract || '',
              authors: paper.authors ? paper.authors.map(a => a.name).join(', ') : 'Unknown',
              journal: paper.journal ? (paper.journal.name || paper.journal) : 'Unknown',
              year: paper.year || (paper.publicationDate ? paper.publicationDate.split('-')[0] : 'Unknown'),
              doi, pmid,
              url: directUrl,
              directUrl,
              source: 'Semantic Scholar',
              priority: 3
            };
          }).filter(p => p.directUrl && p.title !== 'Unknown Title');
        } catch (e) { console.error('Semantic Scholar error:', e.message); return []; }
      })()
    );

    const allResults = await Promise.allSettled(promises);
    const results = [];
    allResults.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) results.push(...r.value);
    });

    // ===== RELEVANCE FILTERING =====
    // Score each paper by how well it matches the query terms
    const scoredPapers = results.map(paper => {
      const titleLower = (paper.title || '').toLowerCase();
      const abstractLower = (paper.abstract || '').toLowerCase();
      const journalLower = (paper.journal || '').toLowerCase();

      let relevanceScore = 0;
      let matchedTerms = 0;

      for (const term of queryTerms) {
        const termLower = term.toLowerCase();
        if (titleLower.includes(termLower)) {
          relevanceScore += 10; // Title match is very important
          matchedTerms++;
        }
        if (abstractLower.includes(termLower)) {
          relevanceScore += 5; // Abstract match is important
          matchedTerms++;
        }
        if (journalLower.includes(termLower)) {
          relevanceScore += 2;
        }
      }

      // Bonus for matching ALL query terms
      if (matchedTerms >= queryTerms.length && queryTerms.length > 0) {
        relevanceScore += 20;
      }

      // Penalty for completely unrelated topics
      const unrelatedTerms = ['obesity', 'weight loss', 'diabetes mellitus type 2', 'parkinson', 'alzheimer', 'stroke'];
      let unrelatedPenalty = 0;
      for (const unrelated of unrelatedTerms) {
        if (!queryLower.includes(unrelated) && (titleLower.includes(unrelated) || abstractLower.includes(unrelated))) {
          // Only penalize if the query doesn't mention it but the paper is about it
          // Check if the paper is DOMINATED by unrelated topic
          const unrelatedCount = (titleLower.match(new RegExp(unrelated, 'g')) || []).length +
                                 (abstractLower.match(new RegExp(unrelated, 'g')) || []).length;
          if (unrelatedCount > 2) {
            unrelatedPenalty += 15;
          }
        }
      }

      paper.relevanceScore = relevanceScore - unrelatedPenalty;
      return paper;
    });

    // Filter out papers with very low relevance
    const relevantPapers = scoredPapers.filter(p => p.relevanceScore >= 5 || queryTerms.length === 0);

    // If we filtered too aggressively, keep top papers anyway
    const finalPapers = relevantPapers.length >= 3 ? relevantPapers : scoredPapers;

    // Deduplicate
    const seen = new Set();
    const unique = [];
    for (const paper of finalPapers) {
      const key = paper.doi || paper.pmid || (paper.title + '|' + paper.year);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(paper);
      }
    }

    // Weighted scoring: balances TRUST + RECENCY + RELEVANCE
    const currentYear = new Date().getFullYear();

    unique.forEach(paper => {
      const year = parseInt(paper.year) || 0;
      const priority = paper.priority || 5;
      const relScore = paper.relevanceScore || 0;

      // Trust weight
      const trustScore = priority === 1 ? 40 :  // PubMed
                        priority === 2 ? 30 :  // Europe PMC
                        priority === 3 ? 20 : 0;

      // Recency weight
      let recencyScore = 0;
      if (year >= currentYear - 1) recencyScore = 30;
      else if (year >= currentYear - 2) recencyScore = 25;
      else if (year >= currentYear - 3) recencyScore = 20;
      else if (year >= currentYear - 5) recencyScore = 15;
      else if (year >= currentYear - 7) recencyScore = 10;
      else if (year >= currentYear - 10) recencyScore = 5;

      // Relevance weight (max 30)
      const relevanceWeight = Math.min(relScore * 2, 30);

      paper.score = trustScore + recencyScore + relevanceWeight;
    });

    // Sort by score
    unique.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Take top 10 with diversity
    const final = [];
    const sourceCounts = {};
    const maxPerSource = 5;

    for (const paper of unique) {
      const src = paper.source || 'Unknown';
      if (!sourceCounts[src]) sourceCounts[src] = 0;
      if (sourceCounts[src] < maxPerSource && final.length < 10) {
        final.push(paper);
        sourceCounts[src]++;
      }
    }

    res.status(200).json({ sources: final, queryTerms });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function extractMedicalTerms(query) {
  // Extract meaningful medical terms from query
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'and', 'but', 'or', 'yet', 'so', 'if',
    'because', 'although', 'though', 'while', 'where', 'when', 'that',
    'which', 'who', 'whom', 'whose', 'what', 'this', 'these', 'those',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
    'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine',
    'yours', 'hers', 'ours', 'theirs', 'what', 'which', 'who', 'whom',
    'whose', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was',
    'were', 'be', 'been', 'being', 'tell', 'me', 'about', 'explain',
    'what', 'how', 'why', 'when', 'where', 'which', 'who', 'give',
    'information', 'details', 'describe', 'discuss', 'list', 'compare',
    'contrast', 'define', 'difference', 'between', 'vs', 'versus'
  ]);

  const words = query
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Also extract multi-word medical phrases
  const phrases = [];
  const queryLower = query.toLowerCase();

  // Common medical phrase patterns
  const phrasePatterns = [
    /(\w+\s+)?(cancer|carcinoma|tumor|neoplasm|malignancy)(\s+\w+)?/gi,
    /(\w+\s+)?(diabetes|mellitus|type\s*\d)(\s+\w+)?/gi,
    /(\w+\s+)?(hypertension|blood\s+pressure)(\s+\w+)?/gi,
    /(\w+\s+)?(heart\s+disease|cardiovascular|cardiac)(\s+\w+)?/gi,
    /(\w+\s+)?(alzheimer|parkinson|dementia|epilepsy|seizure)(\s+\w+)?/gi,
    /(\w+\s+)?(infection|infectious|bacterial|viral|fungal)(\s+\w+)?/gi,
    /(\w+\s+)?(treatment|therapy|management|medication|drug)(\s+\w+)?/gi,
    /(\w+\s+)?(diagnosis|diagnostic|symptom|sign|clinical)(\s+\w+)?/gi,
    /(\w+\s+)?(pathology|pathophysiology|etiology|cause)(\s+\w+)?/gi,
    /(\w+\s+)?(surgery|surgical|operation|procedure)(\s+\w+)?/gi,
  ];

  for (const pattern of phrasePatterns) {
    const matches = queryLower.match(pattern);
    if (matches) {
      matches.forEach(m => {
        const clean = m.trim();
        if (clean.length > 3) phrases.push(clean);
      });
    }
  }

  // Combine unique terms
  const allTerms = [...new Set([...words, ...phrases])];
  return allTerms.slice(0, 15); // Limit to top 15 terms
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
