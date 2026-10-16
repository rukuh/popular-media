const axios = require('axios')
const Promise = require('bluebird')

const getUrl = () => process.env.CHAPTARR_URL || 'http://chaptarr:8789'
const getApiKey = () => process.env.CHAPTARR_API_KEY

const getAudiobookRootFolder = () => process.env.CHAPTARR_AUDIOBOOK_ROOT_FOLDER || '/media/Audiobooks'
const getEbookRootFolder = () => process.env.CHAPTARR_EBOOK_ROOT_FOLDER || '/media/Books'
const getAudiobookQualityProfileId = () => parseInt(process.env.CHAPTARR_AUDIOBOOK_QUALITY_PROFILE_ID || '2', 10)
const getEbookQualityProfileId = () => parseInt(process.env.CHAPTARR_EBOOK_QUALITY_PROFILE_ID || '1', 10)
const getAudiobookMetadataProfileId = () => parseInt(process.env.CHAPTARR_AUDIOBOOK_METADATA_PROFILE_ID || '1', 10)
const getEbookMetadataProfileId = () => parseInt(process.env.CHAPTARR_EBOOK_METADATA_PROFILE_ID || '2', 10)

const getClient = () => {
  return axios.create({
    baseURL: `${getUrl()}/api/v1`,
    headers: {
      'X-Api-Key': getApiKey(),
      'Content-Type': 'application/json'
    },
    timeout: 30000
  })
}

const SUMMARY_KEYWORDS = ['summary', 'compendium', 'discussion prompts', 'study guide', 'workbook', 'companion', 'analysis of', 'cliffnotes', 'sparknotes']
const COLLECTION_KEYWORDS = ['collection', 'box set', 'boxed set', 'series standard edition', 'bundle']

const normalize = (str) => {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const baseTitle = (str) => {
  if (!str) return ''
  const part = str.split(/[:(]/)[0]
  return normalize(part)
}

const scoreCandidate = (candidate, criteria = {}) => {
  const { title: expectedTitle, author: expectedAuthor } = criteria
  if (!expectedTitle && !expectedAuthor) {
    const candTitle = normalize(candidate.title)
    let base = 100
    if (SUMMARY_KEYWORDS.some(k => candTitle.includes(k))) base -= 500
    const votes = candidate.ratings?.votes || 0
    return base + (votes > 0 ? Math.min(50, Math.log10(votes) * 10) : 0)
  }

  const candTitle = normalize(candidate.title)
  const expTitle = normalize(expectedTitle)
  const candBase = baseTitle(candidate.title)
  const expBase = baseTitle(expectedTitle)

  const candAuthor = normalize(candidate.author?.authorName)
  const expAuthor = normalize(expectedAuthor)

  let score = 0

  // Penalize summary / guide unless expected title explicitly includes it
  const isExpSummary = expTitle && SUMMARY_KEYWORDS.some(k => expTitle.includes(k))
  if (!isExpSummary && SUMMARY_KEYWORDS.some(k => candTitle.includes(k))) {
    score -= 1000
  }

  // Penalize collection / omnibus unless expected title explicitly includes it
  const isExpCollection = expTitle && COLLECTION_KEYWORDS.some(k => expTitle.includes(k))
  if (!isExpCollection && COLLECTION_KEYWORDS.some(k => candTitle.includes(k))) {
    score -= 500
  }

  // Title matching
  if (expTitle) {
    if (candBase === expBase || candTitle === expTitle) {
      score += 300
    } else if (candBase.startsWith(expBase) || candTitle.startsWith(expTitle)) {
      score += 150
    } else if ((candBase && expBase && candBase.includes(expBase)) || (candTitle && expTitle && candTitle.includes(expTitle))) {
      score += 50
    } else {
      score -= 100
    }
  }

  // Author matching
  if (expAuthor) {
    if (candAuthor === expAuthor) {
      score += 300
    } else if (candAuthor && expAuthor && (candAuthor.includes(expAuthor) || expAuthor.includes(candAuthor))) {
      score += 200
    } else if (!candAuthor || candAuthor === 'unknown author') {
      score -= 200
    } else {
      score -= 300
    }
  }

  // Ratings / Popularity bonus
  const votes = candidate.ratings?.votes || 0
  if (votes > 0) {
    score += Math.min(100, Math.log10(votes) * 15)
  }

  return score
}

const findBestCandidate = (candidates, criteria = {}) => {
  if (!candidates || candidates.length === 0) return null
  if (!criteria || (!criteria.title && !criteria.author)) {
    return candidates[0]
  }

  let best = null
  let bestScore = -Infinity

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, criteria)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return bestScore >= 0 ? best : null
}

const lookupBook = async (client, term, criteria = {}) => {
  try {
    const res = await client.get('/book/lookup', {
      params: { term }
    })
    return findBestCandidate(res.data, criteria)
  } catch (err) {
    console.warn(`Chaptarr lookup error for "${term}":`, err.message)
    return null
  }
}

const ensureAuthorUnmonitored = async (client, authorId, mediaType = 'ebook') => {
  if (!authorId) return
  try {
    const res = await client.get(`/author/${authorId}`)
    const author = res.data
    if (!author) return

    let needsUpdate = false
    if (author.ebookMonitorFuture !== false || author.ebookMonitorExisting !== 2) {
      author.ebookMonitorFuture = false
      author.ebookMonitorExisting = 2
      needsUpdate = true
    }

    if (mediaType === 'audiobook' || author.audiobookMonitored) {
      if (author.audiobookMonitorFuture !== false || author.audiobookMonitorExisting !== 2) {
        author.audiobookMonitorFuture = false
        author.audiobookMonitorExisting = 2
        needsUpdate = true
      }
    }

    if (needsUpdate) {
      await client.put(`/author/${authorId}`, author)
      console.log(`Updated author ${author.authorName} (ID: ${authorId}) to not monitor future/other books.`)
    }
  } catch (err) {
    console.warn(`Could not update author monitoring settings for author ID ${authorId}:`, err.message)
  }
}

const addBook = async (client, book, mediaType = 'ebook') => {
  const isAudiobook = mediaType === 'audiobook'
  const authorSettings = isAudiobook
    ? {
        lastSelectedMediaType: 'audiobook',
        audiobookQualityProfileId: getAudiobookQualityProfileId(),
        audiobookMetadataProfileId: getAudiobookMetadataProfileId(),
        audiobookRootFolderPath: getAudiobookRootFolder(),
        audiobookMonitorExisting: 2,
        audiobookMonitorFuture: false
      }
    : {
        lastSelectedMediaType: 'ebook',
        ebookQualityProfileId: getEbookQualityProfileId(),
        ebookMetadataProfileId: getEbookMetadataProfileId(),
        ebookRootFolderPath: getEbookRootFolder(),
        ebookMonitorExisting: 2,
        ebookMonitorFuture: false
      }

  const payload = {
    ...book,
    mediaType,
    monitored: true,
    ebookMonitored: !isAudiobook,
    audiobookMonitored: isAudiobook,
    author: {
      ...book.author,
      monitored: true,
      ...authorSettings
    },
    addOptions: {
      addType: 'automatic',
      searchForNewBook: true
    }
  }

  const res = await client.post('/book', payload, {
    params: { mediaType }
  })
  let bookData = res.data

  // If book already existed but was not monitored for the requested media type, update and search
  const isTargetMonitored = isAudiobook ? bookData?.audiobookMonitored : bookData?.ebookMonitored
  if (bookData && bookData.id && (!bookData.monitored || !isTargetMonitored)) {
    try {
      const updatePayload = {
        ...bookData,
        monitored: true,
        [isAudiobook ? 'audiobookMonitored' : 'ebookMonitored']: true
      }
      const updateRes = await client.put(`/book/${bookData.id}`, updatePayload)
      bookData = updateRes.data

      // Trigger automatic search for the newly monitored book
      await client.post('/command', {
        name: 'BookSearch',
        bookIds: [bookData.id]
      })
      console.log(`Updated existing book to monitored and queued search: ${bookData.title} (ID: ${bookData.id}, mediaType: ${mediaType})`)
    } catch (updateErr) {
      console.warn(`Failed to update monitoring for book ID ${bookData.id}:`, updateErr.message)
    }
  }

  if (bookData && bookData.authorId) {
    await ensureAuthorUnmonitored(client, bookData.authorId, mediaType)
  }

  return bookData
}

const syncBooks = async (nytBooks, options = {}) => {
  const mediaType = (typeof options === 'string' ? options : options.mediaType) || 'ebook'
  const apiKey = getApiKey()
  if (!apiKey) {
    console.warn('CHAPTARR_API_KEY not set, skipping Chaptarr sync.')
    return { skipped: true, reason: 'missing_api_key' }
  }

  const client = module.exports.getClient()
  console.log(`Starting Chaptarr direct book sync for ${nytBooks.length} books (${mediaType})...`)

  let addedCount = 0
  let matchedCount = 0
  const results = []

  await Promise.map(nytBooks, async (nytBook) => {
    try {
      const isbn = nytBook.isbn13 || nytBook.isbn10
      let bookCandidate = null
      const criteria = { title: nytBook.title, author: nytBook.author, mediaType }

      if (isbn) {
        bookCandidate = await lookupBook(client, `isbn:${isbn}`, criteria)
      }

      if (!bookCandidate && nytBook.title) {
        bookCandidate = await lookupBook(client, `${nytBook.title} ${nytBook.author || ''}`.trim(), criteria)
      }

      if (!bookCandidate && nytBook.title) {
        bookCandidate = await lookupBook(client, nytBook.title, criteria)
      }

      if (!bookCandidate) {
        console.warn(`Could not find book in Chaptarr: ${nytBook.title} by ${nytBook.author}`)
        return
      }

      matchedCount++
      console.log(`Matched Chaptarr book (${mediaType}): ${bookCandidate.title} by ${bookCandidate.author?.authorName || nytBook.author}`)

      const added = await addBook(client, bookCandidate, mediaType)
      if (added && added.id) {
        addedCount++
        console.log(`Successfully synced to Chaptarr (${mediaType}): ${added.title} (ID: ${added.id})`)
        results.push({ id: added.id, title: added.title, mediaType })
      }

      await Promise.delay(500)
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message
      console.warn(`Could not sync book to Chaptarr (${nytBook.title}, ${mediaType}):`, errMsg)
    }
  }, { concurrency: 2 })

  console.log(`Chaptarr sync complete (${mediaType}). Matched: ${matchedCount}, Synced: ${addedCount}`)
  return {
    status: 'success',
    mediaType,
    matched_count: matchedCount,
    synced_count: addedCount,
    books: results
  }
}

module.exports = {
  syncBooks,
  lookupBook,
  findBestCandidate,
  scoreCandidate,
  addBook,
  ensureAuthorUnmonitored,
  getClient
}
