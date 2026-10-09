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

const lookupBook = async (client, term) => {
  try {
    const res = await client.get('/book/lookup', {
      params: { term }
    })
    return res.data && res.data.length > 0 ? res.data[0] : null
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

      if (isbn) {
        bookCandidate = await lookupBook(client, `isbn:${isbn}`)
      }

      if (!bookCandidate && nytBook.title) {
        bookCandidate = await lookupBook(client, `${nytBook.title} ${nytBook.author || ''}`.trim())
      }

      if (!bookCandidate && nytBook.title) {
        bookCandidate = await lookupBook(client, nytBook.title)
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
      console.error(`Failed to sync book to Chaptarr (${nytBook.title}, ${mediaType}):`, err.message)
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
  addBook,
  ensureAuthorUnmonitored,
  getClient
}
