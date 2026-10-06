const axios = require('axios')
const Promise = require('bluebird')

const getUrl = () => process.env.CHAPTARR_URL || 'http://chaptarr:8789'
const getApiKey = () => process.env.CHAPTARR_API_KEY

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

const ensureAuthorUnmonitored = async (client, authorId) => {
  if (!authorId) return
  try {
    const res = await client.get(`/author/${authorId}`)
    const author = res.data
    if (author && (author.ebookMonitorFuture !== false || author.ebookMonitorExisting !== 2)) {
      author.ebookMonitorFuture = false
      author.ebookMonitorExisting = 2
      await client.put(`/author/${authorId}`, author)
      console.log(`Updated author ${author.authorName} (ID: ${authorId}) to not monitor future/other books.`)
    }
  } catch (err) {
    console.warn(`Could not update author monitoring settings for author ID ${authorId}:`, err.message)
  }
}

const addBook = async (client, book) => {
  const payload = {
    ...book,
    mediaType: 'ebook',
    monitored: true,
    ebookMonitored: true,
    audiobookMonitored: false,
    author: {
      ...book.author,
      monitored: true,
      lastSelectedMediaType: 'ebook',
      ebookQualityProfileId: 1,
      ebookMetadataProfileId: 2,
      ebookRootFolderPath: '/media/Books',
      ebookMonitorExisting: 2,
      ebookMonitorFuture: false
    },
    addOptions: {
      addType: 'automatic',
      searchForNewBook: true
    }
  }

  const res = await client.post('/book', payload)
  let bookData = res.data

  // If book already existed but was not monitored for eBooks, update and search
  if (bookData && bookData.id && (!bookData.monitored || !bookData.ebookMonitored)) {
    try {
      const updatePayload = {
        ...bookData,
        monitored: true,
        ebookMonitored: true
      }
      const updateRes = await client.put(`/book/${bookData.id}`, updatePayload)
      bookData = updateRes.data

      // Trigger automatic search for the newly monitored book
      await client.post('/command', {
        name: 'BookSearch',
        bookIds: [bookData.id]
      })
      console.log(`Updated existing book to monitored and queued search: ${bookData.title} (ID: ${bookData.id})`)
    } catch (updateErr) {
      console.warn(`Failed to update monitoring for book ID ${bookData.id}:`, updateErr.message)
    }
  }

  if (bookData && bookData.authorId) {
    await ensureAuthorUnmonitored(client, bookData.authorId)
  }

  return bookData
}

const syncBooks = async (nytBooks) => {
  const apiKey = getApiKey()
  if (!apiKey) {
    console.warn('CHAPTARR_API_KEY not set, skipping Chaptarr sync.')
    return { skipped: true, reason: 'missing_api_key' }
  }

  const client = module.exports.getClient()
  console.log(`Starting Chaptarr direct book sync for ${nytBooks.length} books...`)

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

      if (!bookCandidate) {
        console.warn(`Could not find book in Chaptarr: ${nytBook.title} by ${nytBook.author}`)
        return
      }

      matchedCount++
      console.log(`Matched Chaptarr book: ${bookCandidate.title} by ${bookCandidate.author?.authorName || nytBook.author}`)

      const added = await addBook(client, bookCandidate)
      if (added && added.id) {
        addedCount++
        console.log(`Successfully synced to Chaptarr: ${added.title} (ID: ${added.id})`)
        results.push({ id: added.id, title: added.title })
      }

      await Promise.delay(500)
    } catch (err) {
      console.error(`Failed to sync book to Chaptarr (${nytBook.title}):`, err.message)
    }
  }, { concurrency: 2 })

  console.log(`Chaptarr sync complete. Matched: ${matchedCount}, Synced: ${addedCount}`)
  return {
    status: 'success',
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
