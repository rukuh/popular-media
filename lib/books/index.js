const Promise = require('bluebird')
const nyt = require('./nyt')
const hardcover = require('./hardcover')
const chaptarr = require('./chaptarr')

const getHardcoverListId = () => process.env.HARDCOVER_LIST_ID
const getHardcoverApiToken = () => process.env.HARDCOVER_API_TOKEN

const BooksIndex = function () {}

BooksIndex.prototype.syncHardcover = async function (nytBooks) {
  const token = getHardcoverApiToken()
  const listSlug = getHardcoverListId()

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

BooksIndex.prototype.sync = async function () {
  console.log('Starting NYT books sync...')

  // 1. Get NYT Best Sellers
  const nytBooks = await nyt.getBestSellers()
  console.log(`Fetched ${nytBooks.length} books from NYT.`)

  // 2. Concurrently update Hardcover List and sync books into Chaptarr
  const [hardcoverResult, chaptarrResult] = await Promise.all([
    this.syncHardcover(nytBooks),
    chaptarr.syncBooks(nytBooks)
  ])

  return {
    nyt_count: nytBooks.length,
    books: nytBooks,
    hardcover: hardcoverResult,
    chaptarr: chaptarrResult,
    status: 'success'
  }
}

// Support the common interface used in server.js handleRequest
BooksIndex.prototype.evaluate = async function (opts = {}) {
  const listName = opts.list || 'combined-print-and-e-book-fiction'
  return nyt.getBestSellers(listName)
}

module.exports = BooksIndex
