==================================================
19A. PERSONAL MOVIE LIBRARY
==================================================

The application should not behave like a simple streaming catalog.

It should combine the convenience of a premium streaming service with the personal movie organization and discovery experience of Letterboxd.

Every user should have a personal movie library where they can organize, track, rate, and manage movies.

The system should be designed around the concept that:

WATCHING = Streaming experience

DISCOVERING = Search, recommendations, genres, people

SAVING = Watchlist / My List

ORGANIZING = Custom Lists / Playlists

TRACKING = Watched History / Diary

RATING = Personal ratings

REVIEWING = Personal reviews

FAVORITING = Favorite movies

Do not make these features feel like separate unrelated systems.

They should all operate on the same underlying Movie objects and UserMovie relationships.

==================================================
19B. MY LIST / WATCHLIST
==================================================

Keep the existing My List functionality, but expand it into a proper personal watchlist system.

Route:

/my-list

The user can save movies they want to watch later.

Every movie should have a quick:

[ + My List ]

action available from:

- Hero
- Movie detail page
- Movie cards
- Search results
- Genre pages
- Similar movie sections

When a movie has already been saved:

[ ✓ In My List ]

Clicking it again should remove the movie.

Do not create duplicate entries.

Use localStorage for the prototype.

Structure the implementation so it can later be replaced with authenticated backend persistence.

==================================================
19C. CUSTOM LISTS / PLAYLISTS
==================================================

This is a major feature.

Users must be able to create their own movie lists/playlists.

Examples:

"90s Classics"

"Best Sci-Fi"

"Christopher Nolan Movies"

"Movies to Watch With Friends"

"Date Night"

"Horror Marathon"

"Best Animated Movies"

"Movies I Want to Rewatch"

The user should NOT be restricted to a single My List.

A user can create unlimited custom lists.

Each list should have:

- id
- name
- description
- coverImage
- movies
- createdAt
- updatedAt
- visibility
- sortOrder

Example conceptual structure:

MovieList:

id
name
description
coverImage
movieIds
createdAt
updatedAt
visibility
sortOrder

Visibility options:

- Private
- Unlisted
- Public

For the prototype, visibility can be local state.

==================================================
19D. CREATE LIST EXPERIENCE
==================================================

Create a polished "Create List" flow.

The user should be able to:

Create a new list.

Enter:

List Name

Description

Choose or automatically generate a cover image.

Choose visibility.

Create the list.

Example:

CREATE NEW LIST

Name
[ Best Sci-Fi Movies ]

Description
[ My favorite science-fiction movies ]

Visibility
[ Private ▼ ]

[ Cancel ] [ Create List ]

Do not make this feel like an administrative form.

It should feel like creating a personal collection.

Use a modal or responsive sheet.

On mobile, use a bottom sheet or full-screen creation interface.

==================================================
19E. ADD MOVIE TO LIST
==================================================

Every movie should support:

[ Add to List ]

Clicking this should open a list-selection popover/modal.

Example:

ADD TO LIST

☑ My List

☐ 90s Classics

☐ Best Sci-Fi

☐ Date Night

[ + Create New List ]

The user can add the movie to multiple lists.

Do not remove the movie from one list when adding it to another.

A movie can belong to unlimited user-created lists.

The interface should clearly indicate which lists already contain the movie.

==================================================
19F. LIST DETAIL PAGE
==================================================

Create a dedicated route:

/list/[id]

A list page should feel like a curated collection rather than a generic grid.

Header:

List cover / collage

List title

Description

Movie count

Creator

Created/updated information

Visibility

Actions:

[ Edit ]

[ Add Movies ]

[ Share ]

[ Delete ]

For the owner.

Below the header:

MOVIES

Display the movies in the user's chosen order.

Support:

- Grid view
- Compact list view where appropriate
- Drag-and-drop reordering for the owner
- Remove from list
- Open movie
- Play movie

The user should be able to manually arrange movies.

Example:

01. The Dark Knight
02. Inception
03. Interstellar
04. Oppenheimer

The order should be treated as meaningful.

==================================================
19G. LIST COVER DESIGN
==================================================

If the user does not select a custom cover image, automatically generate a cinematic collage from movies in the list.

Possible layout:

[ Movie 1 ][ Movie 2 ]
[ Movie 3 ][ Movie 4 ]

Use poster artwork.

If the list contains only one movie, use that movie's poster.

If the list is empty, show an elegant empty-state placeholder.

This makes custom lists visually recognizable throughout the application.

==================================================
19H. MY LIBRARY
==================================================

Create a broader personal library experience.

Route:

/library

This should become the user's personal movie-management hub.

Sections:

Continue Watching

Watchlist

Watched

Favorites

My Ratings

My Reviews

My Lists

Recently Added

Recently Watched

The library should feel like a personal movie dashboard, but remain cinematic and minimal.

Do NOT make it look like a generic SaaS dashboard.

==================================================
19I. WATCH HISTORY / DIARY
==================================================

Create a Letterboxd-inspired viewing history.

Route:

/history

Track movies the user has watched.

Each watched record should contain:

- movieId
- watchedAt
- progress
- completed
- rating
- review
- rewatch

Display a chronological viewing diary.

Example:

AUGUST 24

The Dark Knight
★★★★★
Watched today

AUGUST 22

Interstellar
★★★★½
Watched

AUGUST 18

Dune: Part Two
★★★★★
Rewatched

The interface should make the user's history feel personal.

Provide:

- Date grouping
- Movie poster
- Movie title
- User rating
- Optional review
- Rewatch indicator

For the prototype, persist this using localStorage.

Design the data layer so it can later be moved to backend storage.

==================================================
19J. MARK AS WATCHED
==================================================

Every movie should support:

[ Mark as Watched ]

When selected:

Mark the movie as watched.

Record the current date/time.

Optionally prompt the user to rate it.

Example:

MOVIE WATCHED

Dune: Part Two

How would you rate it?

☆ ☆ ☆ ☆ ☆

[ Skip ] [ Save Rating ]

Do not force the user to rate every movie.

They can simply mark a movie as watched.

==================================================
19K. USER RATINGS
==================================================

Add personal ratings separate from the global movie rating.

Movie metadata may contain:

Global Rating:
8.6

The user may have:

Your Rating:
★★★★½

These are different values.

Support half-star ratings.

Rating range:

0.5 – 5 stars

Allow:

- Rate from movie detail page
- Rate after watching
- Rate from history
- Edit rating later
- Remove rating

The UI should clearly distinguish:

COMMUNITY / GLOBAL RATING

from:

YOUR RATING

==================================================
19L. FAVORITES
==================================================

Allow users to mark movies as favorites.

Every movie should support:

[ ♡ Favorite ]

When active:

[ ♥ Favorite ]

Favorites should be available in:

/favorites

The Favorites page should show the user's favorite movies.

Favorites are different from My List.

My List means:

"I want to watch this."

Favorite means:

"I especially love this movie."

A movie can be both.

==================================================
19M. PERSONAL REVIEWS
==================================================

Add optional Letterboxd-inspired reviews.

After watching a movie, the user can write a personal review.

Example:

Dune: Part Two

Your Rating:
★★★★★

Your Review:

"An absolutely incredible theatrical experience..."

[ Publish Review ]

For the prototype, reviews can be private/local.

Prepare the data model for future public reviews.

Review structure:

Review:

id
movieId
userId
rating
text
createdAt
updatedAt
spoiler
likes

Support spoiler marking.

Spoiler reviews should be visually hidden until the user explicitly chooses:

[ Show Spoiler ]

==================================================
19N. MOVIE DIARY ENTRY
==================================================

The system should treat a watched movie as a diary entry.

A diary entry may contain:

movie
watched date
rating
review
rewatch
favorite

This allows the same movie to potentially be watched multiple times.

Example:

The Lord of the Rings: The Fellowship of the Ring

Dec 12, 2025
★★★★★
Rewatch

Aug 24, 2026
★★★★★
Rewatch

Do NOT assume a movie can only have one watched record.

==================================================
19O. MOVIE ACTION MENU
==================================================

Create a reusable movie action menu.

Available actions:

▶ Play

+ Add to My List

＋ Add to List

✓ Mark as Watched

★ Rate

♥ Add to Favorites

✎ Review

⋯ More

This menu should be accessible from:

- Movie cards
- Movie detail page
- Search results
- List pages
- History

On desktop, use a popover.

On mobile, use a bottom sheet.

Do not make the interface cluttered by showing every action simultaneously.

==================================================
19P. PERSONAL MOVIE PROFILE
==================================================

Create a user profile page.

Route:

/profile/[username]

The profile should feel inspired by Letterboxd but retain the cinematic design language of the streaming platform.

Display:

Avatar

Username

Short bio

Favorite movies

Recently watched

Recent ratings

Recent reviews

Custom lists

Movie statistics

Possible statistics:

Movies Watched
Movies Rated
Movies Reviewed
Hours Watched
Favorite Genre
Most Watched Genre
Average Rating

Keep statistics visually elegant and minimal.

Do not turn the profile into a social-media dashboard.

==================================================
19Q. PRIVATE VS PUBLIC DATA
==================================================

Design the frontend data model with privacy in mind.

Personal data should support visibility states.

Examples:

Watch history:
Private

Ratings:
Private by default

Reviews:
Private by default for prototype

Custom lists:
Private / Unlisted / Public

Favorites:
Private by default

The architecture should make it possible to later expose selected content publicly without restructuring the application.

==================================================
19R. SHARING LISTS
==================================================

Public or unlisted lists should have a share action.

Example:

[ Share List ]

Provide a share interface suitable for:

- Copy link
- Native mobile share
- Social sharing later

A shared list should have a beautiful public-facing view.

Example:

BEST SCI-FI MOVIES

A curated collection of science-fiction movies.

24 movies

[ PLAY ALL ] [ ADD ALL TO MY LIST ]

Then the movie collection.

For a prototype, sharing can simply generate a route such as:

/list/[id]

with mock public visibility.

==================================================
19S. PLAYLIST VS LIST SEMANTICS
==================================================

Do not treat every collection as identical internally.

Support two conceptual collection types:

WATCHLIST

Movies the user intends to watch.

CUSTOM LIST

A manually curated collection.

Examples:

Watchlist:
"Movies I need to watch"

Custom Lists:
"Best Christopher Nolan Movies"
"90s Horror"
"Movies for Friday Night"

A playlist/list can optionally have a defined order.

A watchlist can use automatic sorting such as:

- Recently Added
- Release Date
- Rating
- Alphabetical

==================================================
19T. SMART COLLECTIONS
==================================================

Prepare the architecture for future smart/automatic lists.

Examples:

Recently Watched

Top Rated By Me

Unwatched Movies

Favorite Sci-Fi

Movies Rated 4+ Stars

Recently Added

These should eventually be generated dynamically from user data rather than manually maintained.

For the prototype, implement only the UI/data abstraction needed for future support.

==================================================
19U. RECOMMENDATION PERSONALIZATION
==================================================

Recommendations should eventually use personal activity.

Prepare the architecture for:

- Watched movies
- Ratings
- Favorites
- Genres
- Directors
- Actors
- Custom lists
- Watchlist
- Recently watched

Examples:

BECAUSE YOU WATCHED DUNE

BECAUSE YOU RATED INTERSTELLAR ★★★★★

MORE FROM DENIS VILLENEUVE

YOU MAY ALSO LIKE

BASED ON YOUR LISTS

Do not implement a complex machine-learning recommendation engine.

Create mock recommendation functions such as:

getRecommendedMovies()
getMoviesBasedOnHistory()
getMoviesBasedOnRatings()
getMoviesBasedOnGenres()
getMoviesBasedOnFavorites()

==================================================
19V. PERSONALIZATION DATA MODEL
==================================================

Create a clean abstraction for user/movie relationships.

Example conceptual structure:

UserMovie:

userId
movieId
inWatchlist
isFavorite
isWatched
rating
lastWatchedAt
watchCount
progress
createdAt
updatedAt

WatchedEntry:

id
userId
movieId
watchedAt
rating
reviewId
rewatch

UserList:

id
userId
name
description
coverImage
visibility
type
createdAt
updatedAt

UserListItem:

listId
movieId
position
addedAt

Review:

id
userId
movieId
rating
text
spoiler
createdAt
updatedAt

These are conceptual frontend interfaces.

Do NOT build the backend.

Use localStorage/mock state for the prototype.

==================================================
19W. PERSONALIZATION STATE MANAGEMENT
==================================================

Create reusable hooks/services instead of scattering localStorage logic throughout components.

Examples:

useWatchlist()

useWatchedMovies()

useFavorites()

useRatings()

useMovieLists()

useReviews()

useMovieActions()

The UI should call clean functions such as:

addToWatchlist(movieId)

removeFromWatchlist(movieId)

markAsWatched(movieId)

rateMovie(movieId, rating)

toggleFavorite(movieId)

createList(name)

addMovieToList(listId, movieId)

removeMovieFromList(listId, movieId)

deleteList(listId)

reorderList(listId, movieIds)

addReview(movieId, review)

This will make the prototype easy to replace with real API calls later.

==================================================
19X. DISCOVERY + PERSONALIZATION
==================================================

The application should combine two experiences:

STREAMING DISCOVERY

- Trending
- Popular
- New Releases
- Genres
- Similar Movies
- Search

PERSONAL DISCOVERY

- Because You Watched...
- Your Watchlist
- Your Favorites
- Your Ratings
- Your Lists
- Recently Watched
- Recommended For You

Do not overwhelm the homepage with personalized sections.

Prioritize the most useful content based on available user activity.

For a new user with no activity:

Show general discovery.

For a returning user:

Gradually introduce personalized sections.

==================================================
19Y. LIST MANAGEMENT UX
==================================================

Users should be able to manage lists quickly.

From a list page:

[ + Add Movies ]

[ Edit ]

[ Reorder ]

[ Share ]

[ ⋯ ]

Edit mode should allow:

Rename list

Edit description

Change cover

Change visibility

Remove movies

Reorder movies

Delete list

Use drag-and-drop on desktop where appropriate.

On mobile, provide a touch-friendly reorder experience.

Never make list management dependent on hover.

==================================================
19Z. EMPTY STATES FOR PERSONAL FEATURES
==================================================

Create dedicated empty states for:

Empty Watchlist

No Watched Movies

No Favorites

No Ratings

No Reviews

No Custom Lists

Empty Custom List

No Recommendations Yet

Examples:

YOUR WATCHLIST IS EMPTY

Save movies you want to watch later.

[ Explore Movies ]

YOUR COLLECTIONS

Create your first custom list to organize movies your way.

[ Create List ]

YOUR DIARY IS EMPTY

Movies you mark as watched will appear here.

[ Browse Movies ]

Keep empty states cinematic, minimal, and useful.

==================================================
19AA. GLOBAL MOVIE ACTION CONSISTENCY
==================================================

The same movie should expose consistent personal actions everywhere.

For example, if a user adds:

Dune: Part Two

to "Best Sci-Fi"

then every location showing that movie should immediately reflect the updated state.

If the user marks it as watched:

The movie card should update.

The movie detail page should update.

The history should update.

Recommendations should be able to use the new activity.

If the user rates it:

The user's rating should appear wherever appropriate.

Avoid inconsistent state between pages.

Use a centralized client-side state layer for the prototype.

==================================================
19AB. LETTERBOXD-STYLE MOVIE IDENTITY
==================================================

The platform should not simply answer:

"What can I watch?"

It should also answer:

"What have I watched?"

"What do I want to watch?"

"What do I think about movies?"

"What are my favorite movies?"

"How do I organize movies?"

"What should I watch next?"

This distinction is essential.

The final product should feel like:

Netflix-level streaming discovery

+

Letterboxd-level personal movie organization

without directly copying either platform's branding or interface.

==================================================
19AC. UPDATED NAVIGATION
==================================================

Update the global navigation to support the expanded product.

Desktop:

LEFT:

CINEMA

Home
Movies
TV Shows
My List

CENTER / OPTIONAL:

Discover
Lists

RIGHT:

Search
Profile

The Profile menu should provide access to:

My Library

Watchlist

Watched

Favorites

Ratings

Reviews

My Lists

Settings

Do not put every destination directly into the main navigation.

Keep the primary navigation minimal.

Mobile bottom navigation:

Home
Movies
Search
My List
Profile

Within Profile / Library:

Watchlist
Watched
Favorites
Ratings
Reviews
Lists

==================================================
19AD. UPDATED MOVIE DETAIL ACTIONS
==================================================

The movie detail page should become the primary personal interaction point.

Primary actions:

[ ▶ Play ]

[ + My List ]

Secondary actions:

[ + Add to List ]

[ ✓ Watched ]

[ ★ Rate ]

[ ♥ Favorite ]

[ ✎ Review ]

Do not display all secondary actions as giant buttons.

Use a compact action row or "More" menu depending on viewport.

The hierarchy should remain:

PLAY = primary

SAVE = secondary

PERSONAL ACTIONS = tertiary

==================================================
19AE. UPDATED HOME PAGE PERSONALIZATION
==================================================

Keep the original homepage structure, but dynamically adapt it based on user activity.

New user:

Hero

Trending

Popular

Recently Added

Top Rated

Genres

Returning user:

Hero

Continue Watching

Because You Watched...

Your Watchlist

Trending

Recommended For You

Recently Added

Your Favorites / Based On Your Ratings

Genres

Do not show empty personalized sections.

If the user has no watch history, do not show:

"Because You Watched..."

If the user has no lists, do not show:

"Your Lists"

The interface should feel intelligent rather than empty.

==================================================
19AF. OVERALL PRODUCT PRINCIPLE
==================================================

The application is NOT just a movie streaming frontend.

It is a:

CINEMATIC MOVIE DISCOVERY + STREAMING + PERSONAL LIBRARY PLATFORM.

The product should combine:

Netflix:
- Streaming-first UX
- Personalized discovery
- Continue Watching
- Recommendations
- Premium cinematic presentation

Letterboxd:
- Watched history
- Personal ratings
- Reviews
- Favorites
- Custom lists
- Personal movie diary
- Movie-centric identity

The user should be able to enter the application and naturally progress through:

DISCOVER
↓
VIEW
↓
SAVE
↓
ORGANIZE
↓
WATCH
↓
RATE
↓
REVIEW
↓
REVISIT
↓
DISCOVER SOMETHING ELSE

All of these actions should be connected through the same movie/user data architecture.

The frontend must remain production-quality, responsive, cinematic, and ready to connect to a real backend later.