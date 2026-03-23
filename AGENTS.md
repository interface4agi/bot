# AGENTS

## Purpose

This repo contains small automation agents. The first agent is a Google Apps Script scheduler bot that monitors Gmail and manages meeting-related emails against a Google Calendar.

## Current agent

- `apps-script/calendar_scheduler_bot.js`: scans unread inbox threads, detects meeting scheduling intent, offers available slots, creates calendar events when an exact slot is requested, and refuses any slot that overlaps an existing event or out-of-office block.

## Operating assumptions

- The bot account already has access to the target Google Calendar.
- The bot runs on a 5 minute time-based trigger in Google Apps Script.
- The default working timezone is `Asia/Kolkata`.
- Weekly availability is currently hardcoded from the supplied availability screenshot and should be updated in `BOT_CONFIG.weeklyAvailability` when your schedule changes.

## Safety constraints

- Never book over an existing event.
- Never book over out-of-office time.
- Only react to unread inbox messages whose latest message is not from the bot account.
- If a requested slot is unavailable, reply with alternatives instead of creating an event.
