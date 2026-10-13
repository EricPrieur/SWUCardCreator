// Files under public/ are named by their path from the site's root, like
// /templates/unit/command.webp. The site may be served from a sub-folder, as on
// GitHub Pages, so this turns such a path into one the browser can load.
// Anything else, like an uploaded image's data URL, is returned as it is.
export const asset = (path: string) => (path.startsWith('/') ? import.meta.env.BASE_URL + path.slice(1) : path)
