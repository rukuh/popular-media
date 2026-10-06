const axios = require('axios')

const NYT_API_KEY = process.env.NYT_API_KEY
const BASE_URL = 'https://api.nytimes.com/svc/books/v3'

const getBestSellers = async function (listName = 'combined-print-and-e-book-fiction') {
  try {
    const response = await axios.get(`${BASE_URL}/lists/current/${listName}.json`, {
      params: {
        'api-key': NYT_API_KEY
      }
    })

    const books = response.data?.results?.books || []
    return books.map(book => ({
      title: book.title,
      author: book.author,
      description: book.description,
      isbn10: book.primary_isbn10,
      isbn13: book.primary_isbn13,
      rank: book.rank,
      publisher: book.publisher
    }))
  } catch (error) {
    console.error('Error fetching NYT Best Sellers:', error.message)
    throw error
  }
}

module.exports = {
  getBestSellers
}
