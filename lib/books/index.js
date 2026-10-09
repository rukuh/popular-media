const Promise = require('bluebird')
const nyt = require('./nyt')
const hardcover = require('./hardcover')
const chaptarr = require('./chaptarr')

const getHardcoverListId = () => process.env.HARDCOVER_LIST_ID
const getHardcoverApiToken = () => process.env.HARDCOVER_API_TOKEN

const BooksIndex = function () {}

BooksIndex.prototype.syncHardcover = async function (nytBooks, listSlugOverride) {
  const token = getHardcoverApiToken()
  const listSlug = listSlugOverride || getHardcoverListId()

  if (!token || !listSlug) {
    console.log('Hardcover API token or list ID not configured, skipping Hardcover sync.')
    return { status: 'skipped' }
  }

  try {
    console.log(`Resolving Hardcover list and existing items for: ${listSlug}`)
    const listInfo = await hardcover.getListIdAndBooks(listSlug)

    if (!listInfo) {
      console.warn(`Could not find Hardcover list for: ${listSlug}`)
      return { status: 'list_not_found' }
    }

    const listId = listInfo.id
    const existingListBookIds = listInfo.listBooks.map(lb => lb.id)
    console.log(`Hardcover List ID: ${listId}, found ${existingListBookIds.length} existing items to clear.`)

    // Map NYT books to Hardcover Book IDs
    const newBookIds = await Promise.mapSeries(nytBooks, async (nytBook) => {
      try {
        let hcBook = await hardcover.getBookByISBN(nytBook.isbn13 || nytBook.isbn10)
        if (!hcBook) {
          hcBook = await hardcover.searchBookByTitleAuthor(nytBook.title, nytBook.author)
        }

        if (hcBook) {
          console.log(`Matched Hardcover: ${nytBook.title} -> ID: ${hcBook.id}`)
          await Promise.delay(400)
          return hcBook.id
        } else {
          console.warn(`Could not find book on Hardcover: ${nytBook.title} by ${nytBook.author}`)
          await Promise.delay(400)
          return null
        }
      } catch (err) {
        if (err.isInsufficientScope) {
          throw err
        }
        console.error(`Error matching book on Hardcover (${nytBook.title}):`, err.message)
        return null
      }
    }).filter(id => id !== null)

    const uniqueBookIds = [...new Set(newBookIds)]
    console.log(`Found ${uniqueBookIds.length} unique matching books on Hardcover.`)

    if (uniqueBookIds.length === 0 && nytBooks.length > 0) {
      console.warn('Aborting Hardcover list update: zero books matched from non-empty NYT list (safety threshold safeguard).')
      return {
        status: 'skipped',
        reason: 'zero_matches_safety_abort',
        error: 'Safety abort: zero books matched on Hardcover from non-empty NYT list'
      }
    }

    await Promise.delay(1000)
    await hardcover.replaceBooksInList(listId, existingListBookIds, uniqueBookIds)
    console.log('Successfully updated Hardcover list.')

    return {
      status: 'success',
      matched_count: uniqueBookIds.length
    }
  } catch (err) {
    if (err.isInsufficientScope) {
      console.warn(`Hardcover sync skipped: ${err.message}. Please configure read:catalog scope in Hardcover PAT.`)
      return {
        status: 'skipped',
        reason: 'insufficient_scope',
        error: err.message
      }
    }
    console.error('Hardcover list update failed:', err.message)
    return {
      status: 'failed',
      error: err.message
    }
  }
}

BooksIndex.prototype.sync = async function (opts = {}) {
  const fictionListName = opts.fictionList || process.env.NYT_FICTION_LIST || 'combined-print-and-e-book-fiction'
  const audioListName = opts.audioList || process.env.NYT_AUDIO_LIST || 'audio-fiction'
  const isFalse = val => val === false || val === 'false'
  const isTrue = val => val === true || val === 'true'
  const syncFiction = !isFalse(opts.fiction) && !isTrue(opts.audioOnly)
  const syncAudio = !isFalse(opts.audio) && !isTrue(opts.fictionOnly)

  console.log(`Starting NYT books sync (syncFiction: ${syncFiction}, syncAudio: ${syncAudio})...`)

  let nytFictionBooks = []
  let nytAudioBooks = []

  const fetchTasks = []
  if (syncFiction) {
    fetchTasks.push(nyt.getBestSellers(fictionListName).then(b => { nytFictionBooks = b }))
  }
  if (syncAudio) {
    fetchTasks.push(nyt.getBestSellers(audioListName).then(b => { nytAudioBooks = b }))
  }
  await Promise.all(fetchTasks)

  console.log(`Fetched ${nytFictionBooks.length} fiction books and ${nytAudioBooks.length} audio books from NYT.`)

  let fictionHardcoverResult = { status: 'skipped' }
  let fictionChaptarrResult = { status: 'skipped' }
  if (syncFiction) {
    const [hcRes, chapRes] = await Promise.all([
      this.syncHardcover(nytFictionBooks),
      chaptarr.syncBooks(nytFictionBooks, { mediaType: 'ebook' })
    ])
    fictionHardcoverResult = hcRes
    fictionChaptarrResult = chapRes
  }

  let audioHardcoverResult = { status: 'skipped' }
  let audioChaptarrResult = { status: 'skipped' }
  if (syncAudio) {
    const audioHardcoverSlug = opts.audioHardcoverList || process.env.HARDCOVER_AUDIO_LIST_ID
    const [hcRes, chapRes] = await Promise.all([
      audioHardcoverSlug ? this.syncHardcover(nytAudioBooks, audioHardcoverSlug) : Promise.resolve({ status: 'skipped' }),
      chaptarr.syncBooks(nytAudioBooks, { mediaType: 'audiobook' })
    ])
    audioHardcoverResult = hcRes
    audioChaptarrResult = chapRes
  }

  return {
    status: 'success',
    nyt_count: syncFiction ? nytFictionBooks.length : nytAudioBooks.length,
    books: syncFiction ? nytFictionBooks : nytAudioBooks,
    hardcover: syncFiction ? fictionHardcoverResult : audioHardcoverResult,
    chaptarr: syncFiction ? fictionChaptarrResult : audioChaptarrResult,
    fiction: syncFiction ? {
      list: fictionListName,
      count: nytFictionBooks.length,
      books: nytFictionBooks,
      hardcover: fictionHardcoverResult,
      chaptarr: fictionChaptarrResult
    } : null,
    audio: syncAudio ? {
      list: audioListName,
      count: nytAudioBooks.length,
      books: nytAudioBooks,
      hardcover: audioHardcoverResult,
      chaptarr: audioChaptarrResult
    } : null
  }
}

// Support the common interface used in server.js handleRequest
BooksIndex.prototype.evaluate = async function (opts = {}) {
  const listName = opts.list || 'combined-print-and-e-book-fiction'
  return nyt.getBestSellers(listName)
}

module.exports = BooksIndex
