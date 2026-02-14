// Markdown formatter for YouTube comments
// Used by background service worker via importScripts

const CommentsToMd = {
  MAX_WORDS_PER_PART: 400000,

  // Language-aware labels (no I18n dependency)
  LABELS: {
    en: {
      title: 'YouTube Comments',
      video: 'Video',
      channel: 'Channel',
      published: 'Published',
      views: 'Views',
      likes: 'Likes',
      totalComments: 'Total comments',
      parsedComments: 'Parsed comments',
      parsedAt: 'Parsed at',
      part: 'Part',
      of: 'of',
      comments: 'comments',
      replies: 'replies',
      separator: '==='
    },
    ru: {
      title: 'Комментарии YouTube',
      video: 'Видео',
      channel: 'Канал',
      published: 'Опубликовано',
      views: 'Просмотров',
      likes: 'Лайков',
      totalComments: 'Всего комментариев',
      parsedComments: 'Спарсено комментариев',
      parsedAt: 'Дата парсинга',
      part: 'Часть',
      of: 'из',
      comments: 'комментариев',
      replies: 'ответов',
      separator: '==='
    }
  },

  // Format comments into MD parts
  // Returns [{ title, text }]
  format(videoMetadata, comments, { lang } = {}) {
    const l = this.LABELS[lang] || this.LABELS.en;
    const dateStr = this._formatDateCompact(new Date().toISOString());
    const videoDate = this._formatDateCompact(videoMetadata.publishedAt);
    const totalReplies = comments.reduce((sum, c) => sum + c.replies.length, 0);

    // Build header
    const header = [
      `# ${l.title}`,
      '',
      `**${l.video}:** ${videoMetadata.title}`,
      `**${l.channel}:** ${videoMetadata.channelTitle}`,
      `**${l.published}:** ${videoDate}`,
      `**${l.views}:** ${this._formatNumber(videoMetadata.viewCount)} | **${l.likes}:** ${this._formatNumber(videoMetadata.likeCount)}`,
      `**${l.totalComments}:** ${this._formatNumber(videoMetadata.commentCount)}`,
      `**${l.parsedComments}:** ${comments.length} ${l.comments}, ${totalReplies} ${l.replies}`,
      `**${l.parsedAt}:** ${dateStr}`,
      '',
      l.separator,
      ''
    ].join('\n');

    // Build comment blocks
    const blocks = comments.map(c => this._formatComment(c));

    // Split into parts by word count
    const parts = this._splitIntoParts(header, blocks, l);

    // Generate titles and return
    const videoId = videoMetadata.videoId;
    const today = new Date().toISOString().slice(0, 10);

    const videoTitle = videoMetadata.title || videoId;

    if (parts.length === 1) {
      return [{
        title: `Comments: ${videoTitle}`,
        text: parts[0]
      }];
    }

    return parts.map((text, i) => ({
      title: `Comments: ${videoTitle} (Part ${i + 1})`,
      text
    }));
  },

  // Format a single comment + replies as a block
  _formatComment(comment) {
    const date = this._formatDateCompact(comment.publishedAt);
    const lines = [];

    lines.push(`**${this._sanitize(comment.author)}** | \u{1F44D}${comment.likeCount} | ${date}`);
    lines.push(this._sanitize(comment.text));

    for (const reply of comment.replies) {
      const replyDate = this._formatDateCompact(reply.publishedAt);
      lines.push(`  \u21B3 **${this._sanitize(reply.author)}** | \u{1F44D}${reply.likeCount} | ${replyDate}`);
      lines.push(`  ${this._sanitize(reply.text)}`);
    }

    lines.push('');
    return lines.join('\n');
  },

  // Split blocks into parts respecting MAX_WORDS_PER_PART
  // A thread (comment + replies) is an indivisible block
  _splitIntoParts(header, blocks, l) {
    const parts = [];
    let currentBlocks = [];
    let currentWordCount = this._countWords(header);
    let commentIndex = 0;

    for (const block of blocks) {
      const blockWords = this._countWords(block);

      // If adding this block would exceed limit and we have content, start new part
      if (currentWordCount + blockWords > this.MAX_WORDS_PER_PART && currentBlocks.length > 0) {
        parts.push(currentBlocks);
        currentBlocks = [];
        currentWordCount = 0;
      }

      currentBlocks.push(block);
      currentWordCount += blockWords;
      commentIndex++;
    }

    if (currentBlocks.length > 0) {
      parts.push(currentBlocks);
    }

    // Build final text for each part
    if (parts.length === 1) {
      return [header + parts[0].join('\n')];
    }

    let commentOffset = 0;
    return parts.map((partBlocks, i) => {
      const partHeader = [
        `# ${l.title} — ${l.part} ${i + 1} ${l.of} ${parts.length}`,
        `${l.comments}: ${commentOffset + 1}–${commentOffset + partBlocks.length}`,
        '',
        l.separator,
        ''
      ].join('\n');

      commentOffset += partBlocks.length;

      // First part gets the full header
      if (i === 0) {
        return header + partBlocks.join('\n');
      }
      return partHeader + partBlocks.join('\n');
    });
  },

  // Count words in text
  _countWords(text) {
    return text.split(/\s+/).filter(Boolean).length;
  },

  // Format date as DD.MM.YYYY or pass through relative date strings
  _formatDateCompact(dateInput) {
    if (!dateInput) return '';
    // If it's a relative date string from InnerTube (e.g., "2 years ago"), use as-is
    if (typeof dateInput === 'string' && !dateInput.includes('T')) {
      return dateInput;
    }
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  },

  // Format number with separators
  _formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString('en-US');
  },

  // Sanitize text: decode HTML entities, remove problematic chars
  _sanitize(text) {
    if (!text) return '';
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }
};
