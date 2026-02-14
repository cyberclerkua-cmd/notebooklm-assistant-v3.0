// YouTube Comments API client using InnerTube API for fetching comments
// and DOM scraping for video metadata
// Used by background service worker via importScripts

const YouTubeCommentsAPI = {
  INNERTUBE_URL: 'https://www.youtube.com/youtubei/v1/next',
  REQUEST_DELAY: 100,

  // Error codes
  ERRORS: {
    COMMENTS_DISABLED: 'COMMENTS_DISABLED',
    VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
    INVALID_REQUEST: 'INVALID_REQUEST',
    NETWORK_ERROR: 'NETWORK_ERROR'
  },

  // Extract video ID from various YouTube URL formats
  extractVideoId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?.*v=|youtube\.com\/embed\/|youtube\.com\/v\/|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  },

  // Get video metadata from YouTube page DOM (no API key needed)
  // Uses YouTube's internal data objects for reliable extraction across locales
  // fallbackVideoId: if provided, will be used when DOM extraction fails
  async getVideoMetadataFromDOM(tabId, fallbackVideoId = null) {
    // Retry logic for pages that haven't fully loaded
    const maxRetries = 3;
    const retryDelay = 500;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const watchFlexy = document.querySelector('ytd-watch-flexy');
            const pageData = watchFlexy?.data || watchFlexy?.__data;
            const playerResponse = pageData?.playerResponse || window.ytInitialPlayerResponse || {};
            const videoDetails = playerResponse?.videoDetails || {};

            // Title, author, viewCount, videoId from playerResponse
            let videoId = videoDetails.videoId || '';

            // Fallback: extract videoId from URL if not in playerResponse
            if (!videoId) {
              const urlParams = new URLSearchParams(window.location.search);
              videoId = urlParams.get('v') || '';
            }

            const title = videoDetails.title || document.title.replace(' - YouTube', '');
          const channelTitle = videoDetails.author || '';
          const viewCount = parseInt(videoDetails.viewCount || '0', 10);

          // --- publishedAt: from microformat (locale-independent ISO date) ---
          let publishedAt = '';
          const microformat = playerResponse?.microformat?.playerMicroformatRenderer;
          if (microformat) {
            publishedAt = microformat.publishDate || microformat.uploadDate || '';
          }
          // Fallback: DOM selector
          if (!publishedAt) {
            const dateEl = document.querySelector('#info-strings yt-formatted-string, ytd-watch-metadata #info span');
            if (dateEl) publishedAt = dateEl.textContent?.trim() || '';
          }

          // --- BFS helper to search nested objects for a value ---
          function bfsFind(root, predicate, maxDepth = 15) {
            const stack = [{ obj: root, depth: 0 }];
            while (stack.length > 0) {
              const { obj, depth } = stack.pop();
              if (!obj || typeof obj !== 'object' || depth > maxDepth) continue;
              if (Array.isArray(obj)) {
                for (const item of obj) stack.push({ obj: item, depth: depth + 1 });
                continue;
              }
              const result = predicate(obj);
              if (result !== undefined) return result;
              for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
              }
            }
            return undefined;
          }

          // Helper: parse abbreviated count string ("1.2K", "15 тыс.", "1.5M", "1,5 млн")
          function parseCountStr(str) {
            if (!str) return 0;
            str = String(str).trim();
            if (!str) return 0;
            // Remove non-numeric prefix/suffix, keep digits, dots, commas, spaces and multiplier letters
            const match = str.match(/([\d.,\s]+)\s*([KkМмТтMm]|тыс|млн|тис)?/i);
            if (!match) return 0;
            let num = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
            const suffix = (match[2] || '').toLowerCase();
            if (suffix === 'k' || suffix === 'т' || suffix === 'тыс' || suffix === 'тис') num *= 1000;
            else if (suffix === 'м' || suffix === 'm' || suffix === 'млн') num *= 1000000;
            return Math.round(num);
          }

          // --- likeCount: from pageData internal structures ---
          let likeCount = 0;

          // Strategy 1: BFS for like button view model with toggledText/defaultText
          if (pageData) {
            const likesFromData = bfsFind(pageData, (obj) => {
              // segmentedLikeDislikeButtonViewModel → likeButtonViewModel → likeStatusEntity
              if (obj.segmentedLikeDislikeButtonViewModel) {
                const likeVm = obj.segmentedLikeDislikeButtonViewModel.likeButtonViewModel;
                const likeEntity = likeVm?.likeStatusEntity;
                if (likeEntity?.likeStatus) {
                  // toggleButton has the count
                  const toggleBtn = likeVm?.toggleButtonViewModel?.toggleButtonViewModel;
                  const defaultText = toggleBtn?.defaultButtonViewModel?.buttonViewModel?.title;
                  if (defaultText) return parseCountStr(defaultText);
                }
              }
              // toggledText / defaultText in likeButtonViewModel
              if (obj.toggledText?.content && obj.defaultText?.content &&
                  (obj.toggledText.content.match(/[\d]/) || obj.defaultText.content.match(/[\d]/))) {
                return parseCountStr(obj.defaultText.content || obj.toggledText.content);
              }
              // factoid / topLevelButtons approach
              if (obj.factoid?.factoidRenderer?.value?.simpleText && obj.topLevelButtons) {
                // This is videoPrimaryInfoRenderer — likes are in topLevelButtons
                for (const btn of obj.topLevelButtons) {
                  const tbr = btn.segmentedLikeDislikeButtonRenderer || btn.segmentedLikeDislikeButtonViewModel;
                  if (tbr) {
                    const likeBtn = tbr.likeButton;
                    const toggleBtnR = likeBtn?.toggleButtonRenderer;
                    if (toggleBtnR) {
                      const txt = toggleBtnR.defaultText?.accessibility?.accessibilityData?.label
                        || toggleBtnR.accessibilityData?.accessibilityData?.label || '';
                      if (txt) return parseCountStr(txt);
                    }
                  }
                }
              }
              return undefined;
            }, 20);
            if (likesFromData) likeCount = likesFromData;
          }

          // Strategy 2: DOM fallback — multiple selectors for different layouts
          if (!likeCount) {
            const selectors = [
              'like-button-view-model button[aria-label]',
              'ytd-toggle-button-renderer.ytd-menu-renderer button[aria-label]',
              '#segmented-like-button button[aria-label]',
              'ytd-segmented-like-dislike-button-renderer button[aria-label]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                const ariaLabel = el.getAttribute('aria-label') || '';
                const m = ariaLabel.match(/([\d.,\s]+)/);
                if (m) {
                  const parsed = parseInt(m[1].replace(/[\s.,]/g, ''), 10) || 0;
                  if (parsed > 0) { likeCount = parsed; break; }
                }
              }
            }
          }

          // --- commentCount: from engagementPanels (available before comments lazy-load) ---
          let commentCount = 0;

          if (pageData) {
            // Strategy 1: commentsEntryPointHeaderRenderer in engagementPanels
            const commentsFromData = bfsFind(pageData, (obj) => {
              if (obj.commentsEntryPointHeaderRenderer) {
                const header = obj.commentsEntryPointHeaderRenderer;
                const countText = header.commentCount?.simpleText
                  || header.headerText?.runs?.map(r => r.text).join('') || '';
                if (countText) {
                  const m = countText.match(/([\d.,\s]+)/);
                  if (m) return parseInt(m[1].replace(/[\s.,]/g, ''), 10) || 0;
                }
              }
              // Also check commentsCountText in section header
              if (obj.commentsCount?.simpleText) {
                const m = obj.commentsCount.simpleText.match(/([\d.,\s]+)/);
                if (m) return parseInt(m[1].replace(/[\s.,]/g, ''), 10) || 0;
              }
              return undefined;
            }, 15);
            if (commentsFromData) commentCount = commentsFromData;
          }

          // Strategy 2: ytd-comments component data (if comments section has loaded)
          if (!commentCount) {
            const commentsEl = document.querySelector('ytd-comments');
            const commentsData = commentsEl?.data || commentsEl?.__data;
            if (commentsData) {
              const countFromComments = bfsFind(commentsData, (obj) => {
                if (obj.countText?.runs) {
                  const text = obj.countText.runs.map(r => r.text).join('');
                  const m = text.match(/([\d.,\s]+)/);
                  if (m) return parseInt(m[1].replace(/[\s.,]/g, ''), 10) || 0;
                }
                return undefined;
              }, 10);
              if (countFromComments) commentCount = countFromComments;
            }
          }

          return { videoId, title, channelTitle, publishedAt, viewCount, likeCount, commentCount };
        }
      });
      const result = results?.[0]?.result;

      // Use fallbackVideoId if DOM extraction failed
      if (result && !result.videoId && fallbackVideoId) {
        result.videoId = fallbackVideoId;
        console.log('[YT-Comments] Using fallback videoId from URL:', fallbackVideoId);
      }

      if (result && result.videoId) {
        return result;
      }

      // If no videoId found, retry (page may not be fully loaded)
      if (attempt < maxRetries - 1) {
        console.log(`[YT-Comments] Retry ${attempt + 1}/${maxRetries} - waiting for page to load...`);
        await this._delay(retryDelay);
        continue;
      }

      // Last attempt: use fallbackVideoId with minimal metadata
      if (fallbackVideoId) {
        console.log('[YT-Comments] Using fallback videoId with minimal metadata');
        return {
          videoId: fallbackVideoId,
          title: result?.title || 'YouTube Video',
          channelTitle: result?.channelTitle || '',
          publishedAt: result?.publishedAt || '',
          viewCount: result?.viewCount || 0,
          likeCount: result?.likeCount || 0,
          commentCount: result?.commentCount || 0
        };
      }

      throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
    } catch (e) {
      if (e.code) throw e;
      console.error('getVideoMetadataFromDOM error:', e);

      // On last attempt with fallbackVideoId, return minimal metadata instead of throwing
      if (attempt >= maxRetries - 1 && fallbackVideoId) {
        console.log('[YT-Comments] Script error, using fallback videoId with minimal metadata');
        return {
          videoId: fallbackVideoId,
          title: 'YouTube Video',
          channelTitle: '',
          publishedAt: '',
          viewCount: 0,
          likeCount: 0,
          commentCount: 0
        };
      }

      if (attempt < maxRetries - 1) {
        console.log(`[YT-Comments] Error on attempt ${attempt + 1}, retrying...`);
        await this._delay(retryDelay);
        continue;
      }

      throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
    }
    }
    // Should not reach here, but just in case
    throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
  },

  // Fetch ALL comments via InnerTube API
  // tabId is required to extract ytcfg from the YouTube tab
  // Options: mode ('top'|'newest'), maxComments (0=unlimited), includeReplies (boolean)
  async fetchAllComments(videoId, { progressCallback, cancelToken, tabId, mode = 'top', maxComments = 0, includeReplies = true } = {}) {
    if (!tabId) {
      throw this._makeError(this.ERRORS.INVALID_REQUEST, 'tabId is required for InnerTube API');
    }

    // Step 1: Extract ytcfg and initial data from the YouTube tab
    const ytConfig = await this._extractYtConfig(tabId);
    if (!ytConfig || !ytConfig.INNERTUBE_API_KEY || !ytConfig.INNERTUBE_CONTEXT) {
      throw this._makeError(this.ERRORS.COMMENTS_DISABLED, 'Could not extract YouTube page config. Make sure you are on a YouTube video page.');
    }
    ytConfig.tabId = tabId;

    // Step 2: Find initial continuation token for comments section
    console.log('[YT-Comments] sortMenuItems:', ytConfig.sortMenuItems?.map(s => s.title));
    console.log('[YT-Comments] continuations count:', ytConfig.continuations?.length);
    console.log('[YT-Comments] mode:', mode, 'maxComments:', maxComments, 'includeReplies:', includeReplies);
    const initialToken = this._findCommentsContinuation(ytConfig, mode);
    if (!initialToken) {
      throw this._makeError(this.ERRORS.COMMENTS_DISABLED, 'Comments section not found. Comments may be disabled for this video.');
    }

    // Step 3: Fetch all comments via InnerTube pagination
    // Use two queues: top-level comments first, then replies
    const comments = [];
    const commentMap = new Map(); // id -> comment object (for attaching replies)
    const topQueue = [{ token: initialToken, type: 'top' }];
    const replyQueue = [];
    let pageCount = 0;
    let inRepliesPhase = false;

    // Phase 1 & 2: Process top-level pages first, then reply pages
    while (topQueue.length > 0 || replyQueue.length > 0) {
      if (cancelToken?.cancelled) return comments;

      // Check maxComments limit for top-level comments
      if (maxComments > 0 && comments.length >= maxComments && topQueue.length > 0) {
        // Clear remaining top-level pages, keep reply queue if includeReplies
        topQueue.length = 0;
        if (!includeReplies) {
          replyQueue.length = 0;
          break;
        }
        if (replyQueue.length === 0) break;
      }

      // Prioritize top-level comments over replies
      const isNowReplies = topQueue.length === 0;
      const { token, type } = !isNowReplies
        ? topQueue.shift()
        : replyQueue.shift();

      // Signal transition to replies phase
      if (isNowReplies && !inRepliesPhase) {
        inRepliesPhase = true;
        if (progressCallback) {
          progressCallback({ fetched: comments.length, total: null, phase: 'fetching_replies' });
        }
      }

      const response = await this._fetchCommentPage(token, ytConfig);
      if (!response) continue;

      if (cancelToken?.cancelled) return comments;

      // Parse comments and continuations from response
      const parsed = this._parseInnerTubeResponse(response, type);
      pageCount++;

      if (pageCount <= 5 || pageCount % 50 === 0 || parsed.continuations.filter(c => c.type === 'top').length === 0) {
        console.log(`[YT-Comments] page=${pageCount} type=${type} newComments=${parsed.comments.length} topConts=${parsed.continuations.filter(c=>c.type==='top').length} replyConts=${parsed.continuations.filter(c=>c.type==='replies').length} topQ=${topQueue.length} replyQ=${replyQueue.length} total=${comments.length}`);
      }

      // Process parsed comments
      for (const comment of parsed.comments) {
        if (cancelToken?.cancelled) return comments;

        if (comment.isReply) {
          // Attach reply to parent comment
          const parentId = comment.id.split('.')[0];
          const parent = commentMap.get(parentId);
          if (parent) {
            parent.replies.push({
              id: comment.id,
              author: comment.author,
              text: comment.text,
              likeCount: comment.likeCount,
              publishedAt: comment.publishedAt
            });
          }
        } else {
          // Top-level comment
          const commentObj = {
            id: comment.id,
            author: comment.author,
            text: comment.text,
            likeCount: comment.likeCount,
            publishedAt: comment.publishedAt,
            totalReplyCount: comment.replyCount || 0,
            replies: []
          };
          comments.push(commentObj);
          commentMap.set(comment.id, commentObj);

          if (progressCallback) {
            progressCallback({ fetched: comments.length, total: null });
          }

          // Check limit after adding
          if (maxComments > 0 && comments.length >= maxComments) {
            topQueue.length = 0;
            if (!includeReplies) {
              replyQueue.length = 0;
            }
            break;
          }
        }
      }

      // Route continuations to appropriate queues
      for (const cont of parsed.continuations) {
        if (cont.type === 'top') {
          // Only add if we haven't hit the limit
          if (maxComments === 0 || comments.length < maxComments) {
            topQueue.push(cont);
          }
        } else if (includeReplies) {
          replyQueue.push(cont);
        }
      }

      // Delay between requests
      await this._delay(this.REQUEST_DELAY);
    }

    return comments;
  },

  // Extract ytcfg from YouTube tab via chrome.scripting.executeScript
  // Uses DOM component data instead of window.ytInitialData which goes stale on SPA navigation
  async _extractYtConfig(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const ytcfg = window.ytcfg?.data_ || {};

          // YouTube is an SPA — window.ytInitialData goes stale on navigation.
          // Read current page data from DOM components instead.
          const commentsEl = document.querySelector('ytd-comments');
          const commentsData = commentsEl?.data || commentsEl?.__data;
          const watchFlexy = document.querySelector('ytd-watch-flexy');
          const pageData = watchFlexy?.data || watchFlexy?.__data;

          // BFS helper to find sort menu and continuation tokens
          const continuations = [];
          let sortMenuItems = null;
          const stack = [];
          const MAX_DEPTH = 20;

          // Primary source: comments section data (most reliable for sort menu + continuations)
          if (commentsData) stack.push({ obj: commentsData, depth: 0 });

          // Secondary source: page data (for initial load / fallback)
          if (pageData?.contents?.twoColumnWatchNextResults) {
            const wr = pageData.contents.twoColumnWatchNextResults;
            if (wr.results) stack.push({ obj: wr.results, depth: 0 });
          }
          if (pageData?.engagementPanels) {
            stack.push({ obj: pageData.engagementPanels, depth: 0 });
          }

          // Last resort: window.ytInitialData (stale on SPA nav, but works on fresh page load)
          if (stack.length === 0) {
            const ytInitialData = window.ytInitialData || {};
            const wr = ytInitialData?.contents?.twoColumnWatchNextResults;
            if (wr?.results) stack.push({ obj: wr.results, depth: 0 });
            if (ytInitialData?.engagementPanels) stack.push({ obj: ytInitialData.engagementPanels, depth: 0 });
          }

          while (stack.length > 0) {
            const { obj, depth } = stack.pop();
            if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) continue;

            if (Array.isArray(obj)) {
              for (const item of obj) {
                stack.push({ obj: item, depth: depth + 1 });
              }
              continue;
            }

            // Check for sort menu (sortFilterSubMenuRenderer)
            if (obj.sortFilterSubMenuRenderer?.subMenuItems && !sortMenuItems) {
              sortMenuItems = obj.sortFilterSubMenuRenderer.subMenuItems.map(item => {
                const token = item.serviceEndpoint?.continuationCommand?.token
                  || item.continuation?.reloadContinuationData?.continuation
                  || null;
                return { title: item.title, token, selected: item.selected || false };
              });
            }

            // Check for continuation tokens
            const cc = obj.continuationCommand;
            if (cc?.token) {
              continuations.push({ token: cc.token, targetId: cc.targetId || null });
            }
            const ec = obj.continuationEndpoint?.continuationCommand;
            if (ec?.token) {
              continuations.push({ token: ec.token, targetId: ec.targetId || null });
            }

            for (const v of Object.values(obj)) {
              if (v && typeof v === 'object') {
                stack.push({ obj: v, depth: depth + 1 });
              }
            }
          }

          return {
            INNERTUBE_API_KEY: ytcfg.INNERTUBE_API_KEY || null,
            INNERTUBE_CONTEXT: ytcfg.INNERTUBE_CONTEXT || null,
            continuations,
            sortMenuItems
          };
        }
      });
      return results?.[0]?.result || null;
    } catch (e) {
      console.error('_extractYtConfig error:', e);
      return null;
    }
  },

  // Find the comments section continuation token from extracted data
  // mode: 'top' = Top comments (index 0), 'newest' = Newest first (index 1)
  _findCommentsContinuation(ytConfig, mode = 'top') {
    // Strategy 1: Use sort menu to pick the desired sort order
    if (ytConfig?.sortMenuItems && ytConfig.sortMenuItems.length >= 2) {
      const sortIndex = mode === 'newest' ? 1 : 0;
      const sortItem = ytConfig.sortMenuItems[sortIndex];
      if (sortItem?.token) {
        console.log(`[YT-Comments] Using sort "${sortItem.title}" (mode=${mode})`);
        return sortItem.token;
      }
    }

    // Strategy 2: Fallback to comments-section continuation
    if (ytConfig?.continuations) {
      const commentsToken = ytConfig.continuations.find(
        c => c.targetId === 'comments-section'
      );
      if (commentsToken) return commentsToken.token;

      // Last resort: first continuation token
      if (ytConfig.continuations.length > 0) {
        return ytConfig.continuations[0].token;
      }
    }

    return null;
  },

  // Fetch a page of comments via InnerTube API
  // Executes fetch in the YouTube tab context to send proper cookies/origin
  async _fetchCommentPage(continuation, ytConfig) {
    const apiKey = ytConfig.INNERTUBE_API_KEY;
    const context = ytConfig.INNERTUBE_CONTEXT;
    const tabId = ytConfig.tabId;

    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (apiKey, context, continuation) => {
            try {
              const response = await fetch(
                `https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ context, continuation })
                }
              );
              if (response.ok) {
                return { ok: true, data: await response.json() };
              }
              return { ok: false, status: response.status };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
          args: [apiKey, context, continuation]
        });

        const result = results?.[0]?.result;
        if (!result) {
          throw this._makeError(this.ERRORS.NETWORK_ERROR, 'Script execution failed');
        }

        if (result.ok) {
          return result.data;
        }

        if (result.status && [429, 500, 503].includes(result.status) && attempt < 3) {
          await this._delay(Math.pow(2, attempt) * 1000);
          continue;
        }

        throw this._makeError(
          this.ERRORS.NETWORK_ERROR,
          result.error || `InnerTube API error: HTTP ${result.status}`
        );
      } catch (e) {
        if (e.code) throw e;
        if (attempt >= 3) {
          throw this._makeError(this.ERRORS.NETWORK_ERROR, e.message);
        }
        await this._delay(Math.pow(2, attempt) * 1000);
      }
    }
  },

  // Parse InnerTube response to extract comments and continuations
  // Uses structured parsing via onResponseReceivedEndpoints
  _parseInnerTubeResponse(response, continuationType) {
    const comments = [];
    const continuations = [];
    const seenCommentIds = new Set();

    // Step 1: Extract comments from entity payloads (new format)
    // These are in frameworkUpdates.entityBatchUpdate.mutations
    const mutations = response?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
    for (const mutation of mutations) {
      const payload = mutation?.payload?.commentEntityPayload;
      if (!payload) continue;

      const props = payload.properties || {};
      const author = payload.author || {};
      const toolbar = payload.toolbar || {};

      const commentId = props.commentId || '';
      if (!commentId || seenCommentIds.has(commentId)) continue;
      seenCommentIds.add(commentId);

      let likeCount = 0;
      const likeStr = toolbar.likeCountNotliked || toolbar.likeCountLiked || '';
      if (likeStr) likeCount = this._parseLikeCount(likeStr);

      comments.push({
        id: commentId,
        author: author.displayName || '',
        text: props.content?.content || '',
        likeCount,
        publishedAt: props.publishedTime || '',
        isReply: commentId.includes('.'),
        replyCount: 0
      });
    }

    // Step 2: Process onResponseReceivedEndpoints — the main structure
    const endpoints = response?.onResponseReceivedEndpoints || [];
    for (const endpoint of endpoints) {
      // Get the action object and its target
      const action = endpoint.reloadContinuationItemsCommand
        || endpoint.appendContinuationItemsAction;
      if (!action) continue;

      const targetId = action.targetId || '';
      const isRepliesSection = targetId.startsWith('comment-replies-item');
      const items = action.continuationItems || [];

      for (const item of items) {
        // 2a: Comment thread (top-level comment + reply info)
        const thread = item.commentThreadRenderer;
        if (thread) {
          // Parse comment from old format (commentRenderer) if available
          const comment = this._parseCommentRenderer(thread.comment?.commentRenderer);
          if (comment && !seenCommentIds.has(comment.id)) {
            seenCommentIds.add(comment.id);
            comment.isReply = false;
            comments.push(comment);
          }

          // Extract reply continuations from thread — ALWAYS, regardless of comment format
          // Reply continuations live in thread.replies.commentRepliesRenderer
          // This works for both old (commentRenderer) and new (commentViewModel) formats
          const repliesRenderer = thread.replies?.commentRepliesRenderer;
          if (repliesRenderer) {
            // Update reply count on the matching entity-payload comment
            const viewRepliesText = repliesRenderer.viewReplies?.buttonRenderer?.text;
            if (viewRepliesText) {
              const text = this._extractText(viewRepliesText);
              const countMatch = text.match(/(\d[\d\s,.]*)/);
              if (countMatch) {
                const replyCount = parseInt(countMatch[1].replace(/[\s,.]/g, ''), 10) || 0;
                // Update reply count on the comment (whether parsed here or from entity payloads)
                if (comment) {
                  comment.replyCount = replyCount;
                }
              }
            }
            // Get reply continuation tokens
            // YouTube uses "contents" (old) or "subThreads" (new) for reply continuations
            const replyCont = repliesRenderer.contents || repliesRenderer.subThreads;
            if (replyCont) {
              for (const rc of replyCont) {
                const cir = rc.continuationItemRenderer;
                if (!cir) continue;
                const contToken = cir.continuationEndpoint?.continuationCommand?.token
                  || cir.button?.buttonRenderer?.command?.continuationCommand?.token;
                if (contToken) {
                  continuations.push({ token: contToken, type: 'replies' });
                }
              }
            }
          }
        }

        // 2c: Standalone commentRenderer (for reply pages)
        const commentRenderer = item.commentRenderer;
        if (commentRenderer) {
          const comment = this._parseCommentRenderer(commentRenderer);
          if (comment && !seenCommentIds.has(comment.id)) {
            seenCommentIds.add(comment.id);
            comment.isReply = isRepliesSection || comment.id.includes('.');
            comments.push(comment);
          }
        }

        // 2d: Continuation token for NEXT PAGE (always last item)
        const contRenderer = item.continuationItemRenderer;
        if (contRenderer) {
          const contCmd = contRenderer.continuationEndpoint?.continuationCommand;
          if (contCmd?.token) {
            const type = isRepliesSection ? 'replies' : 'top';
            continuations.push({ token: contCmd.token, type });
          }
          // Also check button-based continuation
          const btnCont = contRenderer.button?.buttonRenderer?.command?.continuationCommand;
          if (btnCont?.token) {
            const type = isRepliesSection ? 'replies' : 'top';
            continuations.push({ token: btnCont.token, type });
          }
        }
      }
    }

    // Deduplicate continuation tokens
    const uniqueContinuations = [];
    const seenTokens = new Set();
    for (const cont of continuations) {
      if (!seenTokens.has(cont.token)) {
        seenTokens.add(cont.token);
        uniqueContinuations.push(cont);
      }
    }

    return { comments, continuations: uniqueContinuations };
  },

  // Parse a commentRenderer into a comment object
  _parseCommentRenderer(renderer) {
    if (!renderer) return null;
    const commentId = renderer.commentId || '';
    if (!commentId) return null;

    return {
      id: commentId,
      author: renderer.authorText?.simpleText || '',
      text: this._extractText(renderer.contentText),
      likeCount: renderer.voteCount?.simpleText
        ? this._parseLikeCount(renderer.voteCount.simpleText)
        : 0,
      publishedAt: renderer.publishedTimeText?.runs?.[0]?.text || '',
      isReply: commentId.includes('.'),
      replyCount: renderer.replyCount || 0
    };
  },

  // Extract text from YouTube's text object (runs or simpleText)
  _extractText(textObj) {
    if (!textObj) return '';
    if (textObj.simpleText) return textObj.simpleText;
    if (textObj.runs) {
      return textObj.runs.map(r => r.text || '').join('');
    }
    return '';
  },

  // Parse like count string (e.g., "1.2K", "15", "1.5M")
  _parseLikeCount(str) {
    if (!str) return 0;
    str = String(str).trim();
    if (!str) return 0;

    const match = str.match(/^([\d.,]+)\s*([KkМмMm])?/);
    if (!match) return 0;

    let num = parseFloat(match[1].replace(',', '.'));
    const suffix = (match[2] || '').toUpperCase();

    if (suffix === 'K' || suffix === 'М') num *= 1000;
    else if (suffix === 'M') num *= 1000000;

    return Math.round(num);
  },

  // Create error with code
  _makeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  },

  // Delay helper
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};
