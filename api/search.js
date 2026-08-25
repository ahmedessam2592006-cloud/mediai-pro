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

    // Extract key medical terms from the query
    const queryTerms = extractMedicalTerms(query);
    const queryLower = query.toLowerCase();

    const cleanQuery = query
      .replace(/[^a-zA-Z0-9\s\-\+\.\,\(\)\[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);

    const promises = [];

    // 1. PubMed
    if (enablePubMed && pubmedApiKey) {
      promises.push(
        (async () => {
          try {
            let searchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=' + 
              encodeURIComponent(cleanQuery) + '&retmax=15&retmode=json&sort=relevance';
            if (pubmedApiKey) searchUrl += '&api_key=' + pubmedApiKey;
            const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(12000) });
            if (!searchRes.ok) return [];
            const searchData = await searchRes.json();
            if (!searchData.esearchresult?.idlist?.length) return [];
            const ids = searchData.esearchresult.idlist.slice(0, 12).join(',');

            let fetchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=' + ids + '&retmode=xml';
            if (pubmedApiKey) fetchUrl += '&api_key=' + pubmedApiKey;
            const fetchRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
            if (!fetchRes.ok) return [];
            const xmlText = await fetchRes.text();

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
                  url: directUrl, directUrl,
                  source: 'PubMed'
                });
              }
            }
            return papers;
          } catch (e) { console.error('PubMed error:', e.message); return []; }
        })()
      );
    }

    // 2. Europe PMC
    if (enableEuropePMC !== false) {
      promises.push(
        (async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);
            const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/SEARCH?query=' + 
              encodeURIComponent(cleanQuery) + 
              '&pageSize=15&format=json&resultType=core&sort_date=y';
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
                url: directUrl, directUrl,
                source: 'Europe PMC'
              };
            }).filter(p => p.directUrl && p.title !== 'Unknown Title');
          } catch (e) { console.error('Europe PMC error:', e.message); return []; }
        })()
      );
    }

    // 3. Semantic Scholar
    promises.push(
      (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          const url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' + 
            encodeURIComponent(cleanQuery) + 
            '&fields=title,authors,year,externalIds,abstract,journal,publicationDate,paperId&limit=15';
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
              url: directUrl, directUrl,
              source: 'Semantic Scholar'
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

    // ===== RELEVANCE SCORING ONLY =====
    // All sources are equal. Only relevance matters.
    const scoredPapers = results.map(paper => {
      const titleLower = (paper.title || '').toLowerCase();
      const abstractLower = (paper.abstract || '').toLowerCase();
      const journalLower = (paper.journal || '').toLowerCase();

      let relevanceScore = 0;
      let matchedTerms = 0;

      for (const term of queryTerms) {
        const termLower = term.toLowerCase();
        if (titleLower.includes(termLower)) {
          relevanceScore += 15; // Title match is most important
          matchedTerms++;
        }
        if (abstractLower.includes(termLower)) {
          relevanceScore += 8; // Abstract match
          matchedTerms++;
        }
        if (journalLower.includes(termLower)) {
          relevanceScore += 3;
        }
      }

      // Bonus for matching ALL query terms
      if (matchedTerms >= queryTerms.length && queryTerms.length > 0) {
        relevanceScore += 25;
      }

      // Check if paper is about a COMPLETELY DIFFERENT topic
      // Extract what the paper is actually about vs what user asked
      const paperTopics = extractTopicsFromText(titleLower + ' ' + abstractLower);
      const queryTopics = extractTopicsFromText(queryLower);

      let topicOverlap = 0;
      for (const qt of queryTopics) {
        for (const pt of paperTopics) {
          if (pt.includes(qt) || qt.includes(pt)) {
            topicOverlap++;
          }
        }
      }

      // If zero topic overlap, moderate penalty (not too strict)
      if (topicOverlap === 0 && queryTopics.length > 0 && paperTopics.length > 0) {
        relevanceScore -= 20;
      }

      paper.relevanceScore = Math.max(0, relevanceScore);
      return paper;
    });

    // Sort by relevance ONLY
    scoredPapers.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

    // Take top 10 most relevant, regardless of source
    const final = scoredPapers.slice(0, 10);

    res.status(200).json({ sources: final, queryTerms });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

function extractMedicalTerms(query) {
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
    'yours', 'hers', 'ours', 'theirs', 'tell', 'me', 'about', 'explain',
    'how', 'why', 'give', 'information', 'details', 'describe', 'discuss',
    'list', 'compare', 'contrast', 'define', 'difference', 'between', 'vs', 'versus'
  ]);

  const words = query
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Extract medical phrases
  const phrases = [];
  const queryLower = query.toLowerCase();

  const medicalPhrases = [
    'lung cancer', 'breast cancer', 'prostate cancer', 'colorectal cancer',
    'skin cancer', 'liver cancer', 'pancreatic cancer', 'brain tumor', 'brain cancer',
    'type 1 diabetes', 'type 2 diabetes', 'gestational diabetes', 'diabetic',
    'hypertension', 'high blood pressure', 'hypotension', 'blood pressure',
    'heart disease', 'cardiovascular disease', 'coronary artery', 'coronary',
    'myocardial infarction', 'heart failure', 'arrhythmia', 'cardiac',
    'alzheimer disease', 'parkinson disease', 'multiple sclerosis', 'ms',
    'epilepsy', 'stroke', 'migraine', 'dementia', 'neurodegenerative',
    'pneumonia', 'tuberculosis', 'covid-19', 'covid', 'coronavirus', 'influenza', 'flu',
    'hepatitis', 'hiv', 'aids', 'malaria', 'malaria',
    'rheumatoid arthritis', 'osteoarthritis', 'lupus', 'sle',
    'asthma', 'copd', 'emphysema', 'bronchitis', 'pulmonary', 'respiratory',
    'kidney disease', 'renal failure', 'dialysis', 'nephrology', 'renal',
    'thyroid', 'hyperthyroidism', 'hypothyroidism', 'endocrine', 'hormone',
    'anemia', 'leukemia', 'lymphoma', 'hematology', 'blood disorder',
    'obesity', 'overweight', 'bariatric', 'weight', 'bmi',
    'depression', 'anxiety', 'bipolar', 'schizophrenia', 'psych', 'mental',
    'cirrhosis', 'fibrosis', 'necrosis', 'hepatic', 'liver',
    'inflammation', 'infection', 'sepsis', 'shock', 'trauma', 'septic',
    'fracture', 'burn', 'wound', 'orthopedic', 'bone',
    'pregnancy', 'prenatal', 'postpartum', 'obstetric', 'gynecology', 'obgyn',
    'pediatric', 'geriatric', 'neonatal', 'child', 'elderly', 'infant',
    'surgery', 'surgical', 'transplant', 'operation', 'procedure',
    'chemotherapy', 'radiation', 'immunotherapy', 'targeted therapy', 'oncology',
    'antibiotic', 'antiviral', 'antifungal', 'antimicrobial', 'antibiotic resistance',
    'vaccine', 'vaccination', 'immunization', 'immunity',
    'genetic', 'mutation', 'chromosome', 'dna', 'rna', 'genome',
    'biomarker', 'pathology', 'histology', 'cytology', 'biopsy',
    'cancer', 'carcinoma', 'tumor', 'neoplasm', 'malignancy', 'metastasis',
    'diabetes', 'mellitus', 'insulin', 'glucose', 'hyperglycemia', 'hypoglycemia',
    'pain', 'chronic pain', 'acute pain', 'analgesic',
    'fever', 'headache', 'nausea', 'vomiting', 'diarrhea', 'constipation',
    'rash', 'allergy', 'allergic', 'anaphylaxis',
    'bleeding', 'hemorrhage', 'coagulation', 'clot', 'thrombosis',
    'jaundice', 'edema', 'swelling', 'fatigue', 'weakness',
    'cough', 'shortness of breath', 'dyspnea', 'chest pain',
    'abdominal pain', 'back pain', 'joint pain', 'muscle pain',
    'dizziness', 'syncope', 'fainting', 'vertigo',
    'tremor', 'paralysis', 'numbness', 'tingling', 'paresthesia',
    'seizure', 'convulsion', 'fit', 'unconscious',
    'shock', 'hypotension', 'tachycardia', 'bradycardia',
    'urinary', 'urine', 'bladder', 'prostate', 'urethra',
    'gastrointestinal', 'gi', 'stomach', 'intestine', 'bowel',
    'esophagus', 'gallbladder', 'pancreas', 'spleen', 'appendix',
    'eye', 'vision', 'blindness', 'glaucoma', 'cataract',
    'ear', 'hearing', 'deafness', 'tinnitus',
    'skin', 'dermatology', 'eczema', 'psoriasis', 'acne',
    'bone', 'osteoporosis', 'osteopenia', 'rickets',
    'vitamin', 'mineral', 'deficiency', 'malnutrition',
    'toxicity', 'poisoning', 'overdose', 'drug interaction',
    'side effect', 'adverse effect', 'contraindication',
    'diagnosis', 'symptom', 'sign', 'clinical', 'differential',
    'treatment', 'therapy', 'management', 'medication', 'drug', 'pharmaceutical',
    'prognosis', 'outcome', 'mortality', 'survival', 'recurrence',
    'risk factor', 'etiology', 'cause', 'pathogenesis', 'pathophysiology',
    'prevention', 'screening', 'early detection', 'prophylaxis',
    'epidemiology', 'incidence', 'prevalence', 'morbidity',
    'case report', 'case study', 'clinical trial', 'randomized',
    'meta-analysis', 'systematic review', 'cohort', 'cross-sectional',
    'biopsy', 'imaging', 'x-ray', 'ct scan', 'mri', 'ultrasound',
    'laboratory', 'blood test', 'urine test', 'culture',
    'surgery', 'operation', 'procedure', 'intervention',
    'rehabilitation', 'physical therapy', 'occupational therapy',
    'palliative', 'hospice', 'end of life', 'terminal',
    'transplant', 'organ donation', 'graft', 'rejection',
    'stem cell', 'gene therapy', 'precision medicine', 'personalized',
    'telemedicine', 'digital health', 'ehealth', 'mhealth',
    'public health', 'global health', 'health policy', 'healthcare',
    'medical ethics', 'informed consent', 'patient autonomy',
    'medical error', 'patient safety', 'quality improvement',
    'nursing', 'pharmacy', 'dentistry', 'veterinary',
    'alternative medicine', 'complementary', 'herbal', 'traditional',
    'acupuncture', 'homeopathy', 'naturopathy', 'chiropractic',
    'yoga', 'meditation', 'mindfulness', 'stress',
    'sleep', 'insomnia', 'sleep apnea', 'restless leg',
    'nutrition', 'diet', 'supplement', 'probiotic',
    'exercise', 'fitness', 'physical activity', 'sedentary',
    'smoking', 'tobacco', 'alcohol', 'substance abuse', 'addiction',
    'drug abuse', 'opioid', 'cocaine', 'cannabis', 'marijuana'
  ];

  for (const phrase of medicalPhrases) {
    if (queryLower.includes(phrase)) {
      phrases.push(phrase);
    }
  }

  const allTerms = [...new Set([...words, ...phrases])];
  return allTerms.slice(0, 20);
}

function extractTopicsFromText(text) {
  // Extract key topic words from text
  const medicalKeywords = [
    'cancer', 'carcinoma', 'tumor', 'neoplasm', 'malignancy', 'oncology', 'metastasis',
    'diabetes', 'mellitus', 'insulin', 'glucose', 'hyperglycemia', 'hypoglycemia', 'diabetic',
    'hypertension', 'blood pressure', 'cardiovascular', 'cardiac', 'heart', 'coronary',
    'alzheimer', 'parkinson', 'dementia', 'epilepsy', 'seizure', 'neuro', 'neurodegenerative',
    'stroke', 'cerebrovascular', 'ischemia', 'hemorrhage', 'brain',
    'pneumonia', 'infection', 'infectious', 'bacterial', 'viral', 'fungal', 'septic',
    'tuberculosis', 'covid', 'coronavirus', 'influenza', 'flu', 'respiratory',
    'hepatitis', 'hiv', 'aids', 'malaria',
    'arthritis', 'rheumatoid', 'osteoarthritis', 'autoimmune', 'sle', 'lupus',
    'asthma', 'copd', 'emphysema', 'bronchitis', 'pulmonary', 'lung',
    'kidney', 'renal', 'dialysis', 'nephrology', 'urinary', 'bladder',
    'thyroid', 'hyperthyroid', 'hypothyroid', 'endocrine', 'hormone',
    'anemia', 'leukemia', 'lymphoma', 'hematology', 'blood',
    'obesity', 'overweight', 'bariatric', 'weight', 'bmi',
    'depression', 'anxiety', 'bipolar', 'schizophrenia', 'psych', 'mental',
    'cirrhosis', 'fibrosis', 'necrosis', 'hepatic', 'liver',
    'inflammation', 'sepsis', 'shock', 'trauma', 'pain',
    'fracture', 'burn', 'wound', 'orthopedic', 'bone', 'surgery',
    'pregnancy', 'prenatal', 'postpartum', 'obstetric', 'gynecology', 'obgyn',
    'pediatric', 'geriatric', 'neonatal', 'child', 'elderly', 'infant',
    'transplant', 'operation', 'procedure', 'surgical',
    'chemotherapy', 'radiation', 'immunotherapy', 'targeted therapy',
    'antibiotic', 'antiviral', 'antifungal', 'antimicrobial', 'drug', 'medication',
    'vaccine', 'vaccination', 'immunization', 'immunity',
    'genetic', 'mutation', 'chromosome', 'dna', 'rna', 'genome',
    'biomarker', 'pathology', 'histology', 'cytology', 'biopsy',
    'symptom', 'sign', 'clinical', 'diagnosis', 'differential',
    'treatment', 'therapy', 'management', 'prognosis', 'outcome',
    'risk factor', 'etiology', 'cause', 'pathogenesis', 'pathophysiology',
    'prevention', 'screening', 'prophylaxis',
    'epidemiology', 'incidence', 'prevalence',
    'imaging', 'x-ray', 'ct scan', 'mri', 'ultrasound',
    'laboratory', 'blood test', 'culture',
    'rehabilitation', 'physical therapy',
    'palliative', 'hospice', 'end of life',
    'stem cell', 'gene therapy', 'precision medicine',
    'public health', 'healthcare',
    'nutrition', 'diet', 'supplement',
    'exercise', 'fitness', 'physical activity',
    'smoking', 'tobacco', 'alcohol', 'substance', 'addiction',
    'sleep', 'insomnia', 'sleep apnea',
    'skin', 'dermatology', 'eczema', 'psoriasis',
    'eye', 'vision', 'ear', 'hearing',
    'fever', 'headache', 'nausea', 'vomiting', 'diarrhea', 'cough',
    'chest pain', 'abdominal pain', 'back pain', 'joint pain',
    'dizziness', 'syncope', 'vertigo',
    'tremor', 'paralysis', 'numbness', 'tingling',
    'bleeding', 'hemorrhage', 'clot', 'thrombosis',
    'jaundice', 'edema', 'swelling', 'fatigue',
    'shortness of breath', 'dyspnea'
  ];

  const found = [];
  const textLower = text.toLowerCase();
  for (const kw of medicalKeywords) {
    if (textLower.includes(kw)) {
      found.push(kw);
    }
  }
  return found;
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
