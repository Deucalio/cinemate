# 🎬 TMDB API (The Movie Database) — Complete Developer Reference & Cheatsheet

A reusable reference guide containing your API credentials, image URL structures, endpoint specifications, copy-paste `cURL` examples, and code snippets in JavaScript/TypeScript & Python.

---

## 🔑 1. API Credentials & Authentication

| Parameter | Value |
| :--- | :--- |
| **API Base URL** | `https://api.themoviedb.org/3` |
| **API Key (v3 auth)** | `94b77b2f5be51b794ccfd399f60fa173` |
| **API Read Access Token (v4 auth)** | `eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0` |

### Two Ways to Authenticate:
1. **Bearer Token Header (Recommended)**:
   ```http
   Authorization: Bearer YOUR_READ_ACCESS_TOKEN
   ```
2. **Query Parameter (v3)**:
   ```http
   ?api_key=94b77b2f5be51b794ccfd399f60fa173
   ```

---

## 🖼️ 2. Image URLs & CDN Formats

TMDB does not return full image URLs; it returns relative paths (e.g. `/path.jpg`). Construct full URLs with:

```text
https://image.tmdb.org/t/p/{size}/{file_path}
```

### Supported Image Sizes:
* **Posters (`poster_path`):** `w92`, `w154`, `w185`, `w342`, `w500`, `w780`, `original`
* **Backdrops (`backdrop_path`):** `w300`, `w780`, `w1280`, `original`
* **Profile / Cast Photos (`profile_path`):** `w45`, `w185`, `h632`, `original`
* **Episode Stills (`still_path`):** `w92`, `w185`, `w300`, `original`

> **Example:**
> `https://image.tmdb.org/t/p/w500/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg`

---

## 📡 3. Key Endpoints & cURL Examples

### 🔍 Search

#### 1. Multi Search (Movies, TV Shows & People simultaneously)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/search/multi?query=dune&include_adult=false&language=en-US&page=1" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0" \
  --header "accept: application/json"
```

#### 2. Search Movies Only
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/search/movie?query=interstellar&include_adult=false&language=en-US&page=1" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

#### 3. Search TV Shows Only
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/search/tv?query=game%20of%20thrones&include_adult=false&language=en-US&page=1" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

---

### 🔥 Trending & Discovery

#### 4. Trending All (Day / Week)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/trending/all/day?language=en-US" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

#### 5. Discover Movies (Filter by Genre, Year, Popularity)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/discover/movie?include_adult=false&page=1&sort_by=popularity.desc&with_genres=28,878" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

#### 6. Discover TV Series (Filter by Genre, Status, Popularity)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/discover/tv?include_adult=false&page=1&sort_by=popularity.desc&with_genres=18,10765" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

---

### 🎬 Movie Details, Cast & Videos

#### 7. Movie Details & External IDs (IMDb ID)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/movie/693134?append_to_response=external_ids,videos,credits,reviews" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

#### 8. Movie Reviews (Direct Endpoint)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/movie/693134/reviews?language=en-US&page=1" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

---

### 📺 TV Series, Seasons & Episodes

#### 8. TV Show Details (Seasons List & Episode Counts)
```bash
curl --request GET \
  --url "https://api.themoviedb.org/3/tv/1399?append_to_response=external_ids" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

#### 9. TV Season Episodes List (Specific Season)
```bash
# Get all episodes in Season 1 of Game of Thrones (TV ID: 1399)
curl --request GET \
  --url "https://api.themoviedb.org/3/tv/1399/season/1" \
  --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"
```

---

## 🏷️ 4. Genre ID Reference Table

### Movie Genre IDs:
| ID | Genre | ID | Genre |
| :--- | :--- | :--- | :--- |
| `28` | Action | `10402` | Music |
| `12` | Adventure | `9648` | Mystery |
| `16` | Animation | `10749` | Romance |
| `35` | Comedy | `878` | Science Fiction |
| `80` | Crime | `10770` | TV Movie |
| `99` | Documentary | `53` | Thriller |
| `18` | Drama | `10752` | War |
| `10751` | Family | `37` | Western |
| `14` | Fantasy | `36` | History |
| `27` | Horror | | |

### TV Show Genre IDs:
| ID | Genre | ID | Genre |
| :--- | :--- | :--- | :--- |
| `10759` | Action & Adventure | `10764` | Reality |
| `16` | Animation | `10765` | Sci-Fi & Fantasy |
| `35` | Comedy | `10766` | Soap |
| `80` | Crime | `10767` | Talk |
| `99` | Documentary | `10768` | War & Politics |
| `18` | Drama | `37` | Western |
| `10762` | Kids | `9648` | Mystery |

---

## 💻 5. Quick Copy-Paste Code Snippets

### JavaScript / TypeScript (Fetch wrapper):
```javascript
const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0';

async function fetchTMDB(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${TMDB_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`TMDB Error: ${response.status}`);
  return await response.json();
}

// Example 1: Search
fetchTMDB('/search/multi', { query: 'Inception' }).then(console.log);

// Example 2: Trending today
fetchTMDB('/trending/all/day').then(console.log);

// Example 3: TV Season episodes
fetchTMDB('/tv/1399/season/1').then(console.log);
```

### Python (Requests):
```python
import requests

TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NGI3N2IyZjViZTUxYjc5NGNjZmQzOTlmNjBmYTE3MyIsIm5iZiI6MTc4NzUzNjcwNy45MDYsInN1YiI6IjZhOGJhNTQzMGQyNGNlZTAzOWMwZWE1YSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pRSYS5G-KfDd8CKGyrNhd62mUo5WI83nLFN7cJEslG0"

def tmdb_request(endpoint, params=None):
    url = f"https://api.themoviedb.org/3{endpoint}"
    headers = {
        "Authorization": f"Bearer {TMDB_TOKEN}",
        "Content-Type": "application/json"
    }
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    return response.json()

# Example Usage
trending = tmdb_request("/trending/movie/week")
print("Top Trending Movie:", trending["results"][0]["title"])
```
