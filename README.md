# bot

This repo contains automation scripts that act on your behalf. The first workflow is a Google Apps Script scheduler bot for Gmail + Google Calendar.

## What it does

- Scans unread inbox emails every 5 minutes.
- Detects meeting scheduling, rescheduling, and cancellation intent.
- Checks your shared Google Calendar before replying.
- Never schedules over existing events or out-of-office blocks.
- Offers slots from your default weekly availability when the sender asks for availability.
- Creates a Google Calendar event when the sender proposes a specific slot that is actually free.

## Current default availability

The script is preloaded with the availability visible in your screenshot, in India Standard Time:

- Sunday: unavailable
- Monday: 2:00pm to 4:00pm, 8:00pm to 9:30pm, 10:30pm to 11:30pm
- Tuesday: 8:30am to 10:00am, 8:00pm to 9:30pm, 10:30pm to 11:30pm
- Wednesday: 8:00pm to 9:30pm, 10:30pm to 11:30pm
- Thursday: 2:00pm to 3:30pm, 8:00pm to 9:30pm, 10:30pm to 11:30pm
- Friday: 8:30am to 10:00am
- Saturday: 3:00pm to 5:00pm

## Files

- `apps-script/calendar_scheduler_bot.js`: Apps Script source to paste into your Google Apps Script project.
- `AGENTS.md`: operating notes and safety constraints for this repo.

## Setup

1. Open Google Apps Script with the bot Google Workspace account.
2. Create a new script project and paste in `apps-script/calendar_scheduler_bot.js`.
3. Set `BOT_CONFIG.calendarId` to the calendar ID that was shared with the bot.
4. Confirm `BOT_CONFIG.botEmail` is set to `sahil@interface4agi.com`.
5. Save and authorize the script.
6. Add a time-driven trigger for `runSchedulerBot` to run every 5 minutes.

## Behavior notes

- If an email proposes an exact date and time, the bot will only create the event if that slot fits the weekly availability and is clear on the calendar.
- If an email asks for availability without locking a specific time, the bot replies with the next open slots.
- If an email asks to cancel a meeting and includes the exact time, the bot attempts to delete the matching event.
- All replies are sent in India Standard Time.
