import {Context, Hono} from 'hono';
import {serve} from '@hono/node-server';
import {Webhooks} from '@octokit/webhooks';
import {
    WebhookEvent,
    WebhookEventName,
    PullRequestEvent,
    PullRequestReviewEvent,
    PullRequestReviewCommentEvent
} from "@octokit/webhooks-types";
import {WebClient} from '@slack/web-api';
import {
    GITHUB_WEBHOOK_SECRET,
    PORT,
    SLACK_BOT_TOKEN, SLACK_WEBHOOK_SECRET,
} from "./config.js";

import {handlePrEvent, handlePrReviewComment, handlePrReviewEvent} from "./webhookHandlers.js";
import {getPrMetaData, parseSlackBody, verifySlackSignature, withPrLock} from "./utils.js";
import {mapper} from "./db.js";
import { logger } from './config.js';

// Initialization
const app = new Hono<{
    Variables: {
        slackBody: string
    }
}>()

const webhooks = new Webhooks({secret: GITHUB_WEBHOOK_SECRET});
export const slackClient = new WebClient(SLACK_BOT_TOKEN);


// --- Hono Route for GitHub Webhooks ---
app.post('/github-webhook', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256');
    const eventType = c.req.header('X-GitHub-Event') as WebhookEventName;
    const payload = await c.req.text();

    if (!signature || !eventType || !payload) {
        logger.warn({ signature: !!signature, eventType, hasPayload: !!payload }, "Received webhook with missing headers or payload");
        return c.json({message: 'Missing headers or payload'}, 400);
    }

    try {
        // Verify the webhook signature
        const isValid = await webhooks.verify(payload, signature);
        if (!isValid) {
            logger.error({ eventType }, "Webhook signature verification failed");
            return c.json({message: 'Invalid signature'}, 401);
        }
        logger.info({ eventType }, "GitHub webhook received and verified");
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage, eventType }, "Webhook signature verification failed");
        return c.json({message: 'Invalid signature'}, 401);
    }

    const parsed_data = JSON.parse(payload) as WebhookEvent;
    if (
        eventType === "pull_request" ||
        eventType === "pull_request_review_comment" ||
        eventType === "pull_request_review"
    ) {
        const { prMsgKey } = getPrMetaData(parsed_data as PullRequestEvent); // works for all PR-based events

        // Yeah, I actually ran into a race condition because GitHub sends multiples events in very quick succession
        // and sometimes duplicate ones for some reason?
        await withPrLock(prMsgKey, async () => {
            if (eventType === "pull_request") {
                await handlePrEvent(parsed_data as PullRequestEvent);
            } else if (eventType === "pull_request_review_comment") {
                await handlePrReviewComment(parsed_data as PullRequestReviewCommentEvent);
            } else if (eventType === "pull_request_review") {
                await handlePrReviewEvent(parsed_data as PullRequestReviewEvent);
            }
        });
    } else {
        logger.debug({ eventType }, "Unhandled GitHub event type received");
    }

    return c.json({message: 'Webhook received and processed'});
});

// Slash command handler for /addGithubUser
// Modified route handlers with proper TypeScript types
app.post('/slack/addGithubUser', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        // Get the raw body from middleware
        const rawBody = c.get('slackBody')

        // Parse the form data with type safety
        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            logger.debug({ userId: slackData.user_id }, "Slack user attempted to add GitHub user without providing username");
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub username. Usage: /addGithubUser <github-username>'
            })
        }

        if (!slackData.user_id) {
            logger.warn("Unable to identify Slack user in /addGithubUser command");
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify user. Please try again.'
            })
        }

        const githubUsername = slackData.text.trim()
        const slackUserId = slackData.user_id

        // Your Redis logic here...
        logger.info({ slackUserId, githubUsername }, "Adding GitHub user mapping for Slack user");
        mapper.setSlackUsername(githubUsername, slackUserId);

        return c.json({
            response_type: 'ephemeral',
            text: `✅ Successfully linked your Slack account to GitHub username: ${githubUsername}`
        })

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, "Error handling /addGithubUser slash command");
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})

app.post('/slack/addChannel', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        const rawBody = c.get('slackBody')
        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            logger.debug({ channelId: slackData.channel_id }, "Slack channel attempted to add GitHub team without providing team name");
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub team name. Usage: /addChannel <github-team>'
            })
        }

        if (!slackData.channel_id) {
            logger.warn("Unable to identify Slack channel in /addChannel command");
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify channel. Please try again.'
            })
        }

        const githubTeam = slackData.text.trim()
        const channelId = slackData.channel_id

        logger.info({ channelId, githubTeam }, "Adding GitHub team to Slack channel mapping");
        mapper.addSlackChannel(githubTeam, channelId);

        return c.json({
            response_type: 'ephemeral',
            text: `✅ Successfully linked this channel to GitHub team: ${githubTeam}`
        })

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, "Error handling /addChannel slash command");
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})

app.post('/slack/removeGithubUser', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        // Get the raw body from middleware
        const rawBody = c.get('slackBody')

        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            logger.debug({ userId: slackData.user_id }, "Slack user attempted to remove GitHub user without providing username");
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub username. Usage: /removeGithubUser <github-username>'
            })
        }

        if (!slackData.user_id) {
            logger.warn("Unable to identify Slack user in /removeGithubUser command");
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify user. Please try again.'
            })
        }

        const githubUsername = slackData.text.trim()
        const slackUserId = slackData.user_id

        logger.info({ slackUserId, githubUsername }, "Removing GitHub user mapping for Slack user");
        mapper.deleteSlackUsername(githubUsername);

        return c.json({
            response_type: 'ephemeral',
            text: `💥 Successfully removed the slack user linked with your github user: ${githubUsername}`
        })

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, "Error handling /removeGithubUser slash command");
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})

app.post('/slack/removeChannel', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        const rawBody = c.get('slackBody')
        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            logger.debug({ channelId: slackData.channel_id }, "Slack channel attempted to remove GitHub team without providing team name");
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub team name. Usage: /addChannel <github-team>'
            })
        }

        if (!slackData.channel_id) {
            logger.warn("Unable to identify Slack channel in /removeChannel command");
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify channel. Please try again.'
            })
        }

        const githubTeam = slackData.text.trim()
        const channelId = slackData.channel_id

        logger.info({ channelId, githubTeam }, "Removing GitHub team from Slack channel mapping");
        mapper.removeSlackChannel(githubTeam, channelId);

        return c.json({
            response_type: 'ephemeral',
            text: `💥 Successfully unlinked this channel from GitHub team: ${githubTeam}`
        })

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMessage }, "Error handling /removeChannel slash command");
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})

// --- Health Check Route ---
app.get('/health', async (c) => {
    const healthStatus = {
        status: 'ok',
        database: 'ok',
        slack: 'ok',
        timestamp: new Date().toISOString()
    };
    const errors: string[] = [];

    try {
        if (!mapper.isHealthy()) { //
            throw new Error('Database health check failed');
        }
    } catch (error: any) {
        healthStatus.database = 'error';
        errors.push(error.message);
    }

    try {
        const slackAuth = await slackClient.auth.test();
        if (!slackAuth.ok) {
            throw new Error(slackAuth.error || 'Slack authentication test failed');
        }
    } catch (error: any) {
        healthStatus.slack = 'error';
        errors.push(error.message);
    }

    if (errors.length > 0) {
        healthStatus.status = 'error';
        logger.error({ errors, healthStatus }, "Health check failed");
        c.status(503); // Use 503 Service Unavailable for failing health checks
    } else {
        logger.info("Health check passed");
    }

    return c.json(healthStatus);
});

// --- Start Server ---
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    logger.info({ port: info.port }, "Server started and listening for requests");
});