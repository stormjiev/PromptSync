// T073: Version Check Module
// Checks for updates by comparing the local manifest version with the latest
// GitHub Release of stormjiev/PromptSync.

import { t } from './i18n.js';

const GITHUB_OWNER = 'stormjiev';
const GITHUB_REPO = 'PromptSync';
const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

/**
 * Normalize a release tag / version string into a comparable "x.y.z" form.
 * Strips a leading "v" (e.g. "v0.2.15" -> "0.2.15").
 * @param {string} value
 * @returns {string}
 */
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

/**
 * Load local manifest version
 * @returns {Promise<Object>} {version, manifest}
 */
export async function loadVersionInfo() {
  try {
    const manifest = chrome.runtime.getManifest();
    return {
      version: manifest.version,
      manifest: manifest
    };
  } catch (error) {
    console.error('Error loading manifest:', error);
    return null;
  }
}

/**
 * Fetch the latest GitHub Release metadata.
 * @returns {Promise<Object|null>} Latest release object or null on error
 */
export async function fetchLatestRelease() {
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_API, {
      headers: {
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub release fetch error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching latest release:', error);
    return null;
  }
}

/**
 * Compare two version strings (e.g., "1.0.0" vs "1.1.0")
 * @param {string} current - Current version
 * @param {string} latest - Latest version
 * @returns {number} -1 if current < latest, 0 if equal, 1 if current > latest
 */
function compareVersions(current, latest) {
  const currentParts = normalizeVersion(current).split('.').map(Number);
  const latestParts = normalizeVersion(latest).split('.').map(Number);

  const maxLength = Math.max(currentParts.length, latestParts.length);

  for (let i = 0; i < maxLength; i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }

  return 0;
}

/**
 * Pick the best download URL from a release: prefer the first .zip asset,
 * fall back to the auto-generated source zipball, then the releases page.
 * @param {Object|null} release
 * @returns {string}
 */
function pickDownloadUrl(release) {
  if (release) {
    const zipAsset = (release.assets || []).find(
      (a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.zip')
    );
    if (zipAsset && zipAsset.browser_download_url) {
      return zipAsset.browser_download_url;
    }
    if (release.zipball_url) {
      return release.zipball_url;
    }
    if (release.html_url) {
      return release.html_url;
    }
  }
  return GITHUB_RELEASES_PAGE;
}

/**
 * Check if an update is available by comparing against the latest GitHub Release.
 * @returns {Promise<Object>} Update status (includes downloadUrl)
 */
export async function checkForUpdates() {
  const localInfo = await loadVersionInfo();
  if (!localInfo) {
    return {
      updateAvailable: false,
      error: t('errVersionInfoFailed'),
      downloadUrl: GITHUB_RELEASES_PAGE
    };
  }

  const latestRelease = await fetchLatestRelease();
  if (!latestRelease || !latestRelease.tag_name) {
    return {
      updateAvailable: false,
      currentVersion: localInfo.version,
      error: t('errGitHubFetchFailed'),
      downloadUrl: GITHUB_RELEASES_PAGE
    };
  }

  const latestVersion = normalizeVersion(latestRelease.tag_name);
  const comparison = compareVersions(localInfo.version, latestVersion);
  const updateAvailable = comparison < 0;

  return {
    updateAvailable,
    currentVersion: localInfo.version,
    latestVersion,
    downloadUrl: pickDownloadUrl(latestRelease),
    error: null
  };
}

/**
 * Get the default (static) download URL for the latest version.
 * checkForUpdates() returns a more precise per-release asset URL when available.
 * @returns {string} GitHub releases page URL
 */
export function getDownloadUrl() {
  return GITHUB_RELEASES_PAGE;
}

/**
 * Get the GitHub repository URL
 * @returns {string} GitHub repository URL
 */
export function getRepositoryUrl() {
  return GITHUB_REPO_URL;
}
