# Instagram & Social Media Reach Rule

Whenever the user shares an Instagram link (`instagram.com/reel/...`, `instagram.com/p/...`, `instagram.com/...`), Twitter/X link, or any social media link:

1. **Always Use `agent-reach` Mechanism**:
   - Immediately route the URL through Jina Reader (`https://r.jina.ai/<instagram_url>`) using `read_url_content` or `curl`.
   - If Jina Reader needs browser context, invoke OpenCLI (`opencli instagram ...`) or browser subagent.
2. **Never Ignore or Ask User for Video Text**:
   - Automatically extract caption, creator handle, transcript, mentioned tools, links, and comments from the social post.
3. **Execute Relevant Intent**:
   - Parse all mentioned tools, skills, or instructions in the post and immediately incorporate them into the user's task.
