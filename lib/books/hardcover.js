const axios = require('axios')
const Promise = require('bluebird')

const HARDCOVER_API_TOKEN = process.env.HARDCOVER_API_TOKEN
const GRAPHQL_ENDPOINT = 'https://api.hardcover.app/v1/graphql'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const graphqlRequest = async (query, variables = {}, retries = 4, backoffMs = 2000) => {
  try {
    const response = await axios.post(
      GRAPHQL_ENDPOINT,
      { query, variables },
      {
        headers: {
          Authorization: `Bearer ${HARDCOVER_API_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'popular-movies/1.0'
        }
      }
    )

    if (response.data.errors) {
      throw new Error(JSON.stringify(response.data.errors))
    }

    return response.data.data
  } catch (error) {
    const status = error.response?.status
    const isTransient5xx = status >= 500 && status <= 504
    const isNetworkError = !error.response && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND')
    const isRateLimitedOrForbidden = status === 429 || status === 403

    if ((isRateLimitedOrForbidden || isTransient5xx || isNetworkError) && retries > 0) {
      const retryAfter = error.response?.headers?.['retry-after']
      const parsedSeconds = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delayMs = !isNaN(parsedSeconds) && parsedSeconds > 0 ? (parsedSeconds * 1000) : backoffMs
      const reason = status === 429 ? 'Rate limit (429)' : (status === 403 ? 'Access forbidden / rate limited (403)' : (status ? `HTTP ${status}` : (error.code || 'Network error')))
      console.warn(`Hardcover API ${reason}. Waiting ${delayMs}ms before retry (${retries} attempts left)...`)
      await sleep(delayMs)
      return graphqlRequest(query, variables, retries - 1, backoffMs * 2)
    }

    console.error('Hardcover GraphQL Error:', error.message)
    throw error
  }
}

const getListIdAndBooks = async (slug) => {
  const query = `
    query GetListAndBooks($slug: String!) {
      lists(where: { slug: { _eq: $slug } }) {
        id
        list_books {
          id
        }
      }
    }
  `
  const data = await graphqlRequest(query, { slug })
  if (!data.lists[0]) return null
  return {
    id: data.lists[0].id,
    listBooks: data.lists[0].list_books
  }
}

const getBookByISBN = async (isbn) => {
  const query = `
    query GetBookByISBN($isbn: String!) {
      editions(where: {
        _or: [
          { isbn_10: { _eq: $isbn } },
          { isbn_13: { _eq: $isbn } }
        ]
      }) {
        book {
          id
          title
        }
      }
    }
  `
  const data = await graphqlRequest(query, { isbn })
  return data.editions[0]?.book
}

const searchBookByTitleAuthor = async (title, author) => {
  const query = `
    query SearchBooks($query: String!) {
      search(query: $query, per_page: 10) {
        results
      }
    }
  `
  const data = await graphqlRequest(query, { query: title })
  const results = data?.search?.results?.hits || []

  // Try to find a result where the author names match
  const normalizedAuthor = author.toLowerCase().trim()
  const matchedResult = results.find(r => {
    const doc = r.document
    if (!doc) return false

    if (doc.author_names && Array.isArray(doc.author_names)) {
      return doc.author_names.some(name =>
        name.toLowerCase().includes(normalizedAuthor) ||
        normalizedAuthor.includes(name.toLowerCase())
      )
    }
    return false
  })

  if (matchedResult && matchedResult.document) {
    return {
      id: parseInt(matchedResult.document.id, 10),
      title: matchedResult.document.title
    }
  }

  // Fallback to the first search result if no author match was found but we have results
  if (results[0] && results[0].document) {
    return {
      id: parseInt(results[0].document.id, 10),
      title: results[0].document.title
    }
  }

  return null
}

const replaceBooksInList = async (listId, existingListBookIds, newBookIds) => {
  if (existingListBookIds.length === 0 && newBookIds.length === 0) {
    console.log('No existing books to delete and no new books to insert.')
    return { status: 'no_change' }
  }

  const BATCH_SIZE = 1;

  // 1. Delete existing in batches
  const deleteBatches = [];
  for (let i = 0; i < existingListBookIds.length; i += BATCH_SIZE) {
    deleteBatches.push(existingListBookIds.slice(i, i + BATCH_SIZE));
  }

  await Promise.mapSeries(deleteBatches, async (batch, bIndex) => {
    let mutation = 'mutation DeleteBooksInListBatch {\n';
    batch.forEach((id, index) => {
      mutation += `  del_${index}: delete_list_book(id: ${id}) {\n    id\n  }\n`;
    });
    mutation += '}';
    console.log(`Deleting batch ${bIndex + 1}/${deleteBatches.length}...`);
    const res = await graphqlRequest(mutation);
    await sleep(1000);
    return res;
  });

  // 2. Insert new in batches
  const insertBatches = [];
  for (let i = 0; i < newBookIds.length; i += BATCH_SIZE) {
    insertBatches.push(newBookIds.slice(i, i + BATCH_SIZE));
  }

  await Promise.mapSeries(insertBatches, async (batch, bIndex) => {
    let mutation = 'mutation InsertBooksInListBatch {\n';
    batch.forEach((bookId, index) => {
      const position = (bIndex * BATCH_SIZE) + index + 1;
      mutation += `  ins_${index}: insert_list_book(object: {\n    list_id: ${listId},\n    book_id: ${bookId},\n    position: ${position}\n  }) {\n    id\n  }\n`;
    });
    mutation += '}';
    console.log(`Inserting batch ${bIndex + 1}/${insertBatches.length}...`);
    const res = await graphqlRequest(mutation);
    await sleep(1000);
    return res;
  });

  return { status: 'success' };
}

module.exports = {
  getListIdAndBooks,
  getBookByISBN,
  searchBookByTitleAuthor,
  replaceBooksInList,
  graphqlRequest
}
