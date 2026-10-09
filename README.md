# popular-media (Fork)

> [!NOTE]
> This is a fork of the original [sjlu/popular-movies](https://github.com/sjlu/popular-movies) project, extended with additional functionality including Anime integration.

Popular Movies uses LLMs to evaluate the popularity of movies and anime. It considers a multitude of data points such as ratings, popularity, production companies, actors, and real-time community hype.

## Usage

> :warning: **The URL has changed from `https://s3.amazonaws.com/popular-movies/` to `https://popular-movies-data.stevenlu.com/` as of September 11, 2023.**
> Access via S3 using TLS 1.0 or 1.1 will be [deprecated by AWS](https://aws.amazon.com/blogs/security/tls-1-2-required-for-aws-endpoints/) on December 31, 2023.
> Access via S3 will be completely deprecated January 1, 2025.

You can poll the following JSON file for a list of movies.

```
https://popular-movies-data.stevenlu.com/movies.json
```

  * This file is regenerated nightly so it is recommended that you
    only poll this file once per day
  * It is recommended that you take a snapshot of this list and not
    remove based on the list no longer displaying a particular movie
  * Subject to fair use; excessive usage will be rate limited

## Popular Anime

This fork introduces a new `/anime` endpoint that aggregates data from multiple sources:
- **AniList**: Metadata, seasonal trending, and popularity.
- **MyAnimeList (via Jikan)**: Global scores and consensus.
- **Kitsu**: Community ratings and trending status.
- **Reddit (r/anime)**: Weekly episode karma and discussion hype.
- **Simkl**: Peer trending and cross-platform popularity.

```
http://localhost:3000/anime
```

Parameters:
- `anticipated=true`: Set to true to include shows that haven't aired yet (defaults to false).
- `exclude_sequels=true`: Set to true to filter out sequels, spin-offs, and returning seasons of existing franchises (defaults to false).
- `include_genres=action,sci-fi`: Comma-separated list of genres to include (strict filter).
- `exclude_genres=romance,slice of life`: Comma-separated list of genres to exclude (strict filter).
- `disliked_genres=horror`: Comma-separated list of genres to weigh negatively (AI evaluation).
- `preferred_genres=romance`: Comma-separated list of genres to weigh positively and handle leniently in ratings (AI evaluation).
- `include_tags=cyberpunk,post_apocalyptic`: Comma-separated list of granular AniList tags to include (strict filter).
- `exclude_tags=horror,supernatural`: Comma-separated list of granular AniList tags to exclude (strict filter).
- `disliked_tags=mecha`: Comma-separated list of tags to weigh negatively (AI evaluation).
- `preferred_tags=school_club`: Comma-separated list of tags to weigh positively and handle leniently in ratings (AI evaluation).
- `limit=5`: Limit the number of results returned.

### Popular Books & Audiobooks

The `/books` and `/audiobooks` endpoints return cached lists of current New York Times bestsellers, formatted consistently with the other media endpoints:

```
http://localhost:3000/books
http://localhost:3000/audiobooks
```

Parameters:
- `list=combined-print-and-e-book-fiction`: NYT bestsellers list name (defaults to `combined-print-and-e-book-fiction` for `/books`, and `audio-fiction` for `/audiobooks`).
- `limit=5`: Limit the number of results returned.
- `clear_cache=true`: Force cache invalidation and fresh fetch.

### Books & Audiobooks Dual Sync

To synchronize current NYT bestsellers directly into Hardcover and Chaptarr:

```
POST /books/sync
```

This triggers a dual sync:
1. **Fiction Bestsellers (`combined-print-and-e-book-fiction`)**: Synced to Hardcover (if `HARDCOVER_LIST_ID` configured) and Chaptarr as **eBooks** (`/media/Books`).
2. **Audio Fiction Bestsellers (`audio-fiction`)**: Synced to Hardcover (if `HARDCOVER_AUDIO_LIST_ID` configured) and Chaptarr as **audiobooks** (`/media/Audiobooks`).

An automated weekly sync also runs every Wednesday at 7:00 PM.

Optional environment variables:
- `NYT_FICTION_LIST`: Defaults to `combined-print-and-e-book-fiction`.
- `NYT_AUDIO_LIST`: Defaults to `audio-fiction`.
- `HARDCOVER_AUDIO_LIST_ID`: Hardcover list slug for audiobook sync (optional).
- `CHAPTARR_AUDIOBOOK_ROOT_FOLDER`: Defaults to `/media/Audiobooks`.
- `CHAPTARR_EBOOK_ROOT_FOLDER`: Defaults to `/media/Books`.
- `CHAPTARR_AUDIOBOOK_QUALITY_PROFILE_ID`: Defaults to `2`.
- `CHAPTARR_EBOOK_QUALITY_PROFILE_ID`: Defaults to `1`.

## Data Aggregation

The service aggregates the following data points for evaluation:

### Movies
- **Metadata (TMDB)**: Budget, Revenue, Production Companies, Genres, Release Date.
- **Cast/Crew (TMDB)**: Top 3 Lead Actors, Director, Writer.
- **Ratings**: Metacritic Score, Rotten Tomatoes Score, IMDb Rating, IMDb Vote Count, TMDB Average Vote, TMDB Vote Count.
- **Popularity**: TMDB Popularity Metric.
- **Preferences**: Supports `disliked_genres` for negative AI weighting.

### Anime
- **Metadata (AniList)**: Title, Studio, Genres, Granular Tags, Description, Status.
- **Consensus Scores**: MyAnimeList Score, AniList Average Score, Kitsu Average Rating.
- **Hype Signals**: Reddit Weekly Karma (via AnimeKarmaList), AniList Popularity & Trending.
- **Platform Signals**: Simkl Trending (Peer-based popularity).
- **Preferences**: Supports `disliked_genres` and `disliked_tags` for negative AI weighting, and `preferred_genres` and `preferred_tags` for positive AI weighting.

### Seasonal Transition Handling

During seasonal transition windows, the `/anime` endpoint automatically pairs and queries two seasons in parallel to bridge the gap:
- **End of Season Transition (last 15 days of a season):** Fetches both the *current* ending season and the *upcoming* season.
- **Start of Season Transition (first 15 days of a season):** Fetches both the *current* starting season and the *previous* season.
- **Finished Status Retention:** AniList queries fetch shows with `FINISHED` status in addition to `RELEASING` and `NOT_YET_RELEASED`, ensuring recently finished high-quality shows stay in the candidate pool.
- **Not-Yet-Released Buffer:** When `anticipated=false`, `NOT_YET_RELEASED` shows are allowed to pass through during these transition windows so they can be processed right before they premiere.
- **AI Contextual Guidelines:** Today's date and season name are passed to the LLM as context, prompting it to prioritize high-quality finished or finishing shows as a buffer rather than filling the list with lower-quality shows.

## LLM Evaluation

The evaluation logic is unified across both Movies and Anime services. It supports multiple providers via `lib/ai.js`:
- **Google GenAI (Gemini)**: Primary provider if `GEMINI_API_KEY` is present.
- **Anthropic (Claude 3.5 Sonnet)**: Secondary provider if `ANTHROPIC_API_KEY` is present.
- **Fallback**: If no API keys are provided or evaluation fails, the service falls back to a weighted popularity/score ranking.

## Develop

* Make sure you are running Node.js

* If you want to run it locally you can clone this repository and add a
  `.env` file which includes the following lines

    ```
    TMDB_KEY=
    OMDB_KEY=
    GEMINI_API_KEY=
    ANTHROPIC_API_KEY=
    ```

* Then run `npm start` to launch the Express server on port 3000.

* For containerized deployment, use the provided `Dockerfile`.

## License

MIT
