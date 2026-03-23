/* eslint-disable no-var */
/**
 * Google Apps Script entrypoint + testable scheduling core.
 *
 * Copy this file into your Apps Script project, update BOT_CONFIG.calendarId,
 * and set a time-driven trigger for `runSchedulerBot` every 5 minutes.
 */

var BOT_CONFIG = {
  botEmail: 'sahil@interface4agi.com',
  calendarId: 'REPLACE_WITH_TARGET_CALENDAR_ID',
  timeZone: 'Asia/Kolkata',
  defaultMeetingDurationMinutes: 30,
  maxSlotsPerReply: 5,
  lookAheadDays: 21,
  managedThreadLabel: 'bot/scheduler-managed',
  weeklyAvailability: {
    0: [],
    1: [
      { start: '14:00', end: '16:00' },
      { start: '20:00', end: '21:30' },
      { start: '22:30', end: '23:30' }
    ],
    2: [
      { start: '08:30', end: '10:00' },
      { start: '20:00', end: '21:30' },
      { start: '22:30', end: '23:30' }
    ],
    3: [
      { start: '20:00', end: '21:30' },
      { start: '22:30', end: '23:30' }
    ],
    4: [
      { start: '14:00', end: '15:30' },
      { start: '20:00', end: '21:30' },
      { start: '22:30', end: '23:30' }
    ],
    5: [
      { start: '08:30', end: '10:00' }
    ],
    6: [
      { start: '15:00', end: '17:00' }
    ]
  }
};

function runSchedulerBot() {
  return SchedulerBot.run();
}

var SchedulerBot = (function () {
  var WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var MONTH_NAMES = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };

  function run(deps) {
    deps = deps || getGoogleDeps();
    var label = ensureLabel_(deps.GmailApp, BOT_CONFIG.managedThreadLabel);
    var threads = deps.GmailApp.search('in:inbox is:unread newer_than:30d', 0, 25);
    var processed = [];

    for (var i = 0; i < threads.length; i += 1) {
      var thread = threads[i];
      var outcome = processThread(thread, deps);
      if (!outcome) {
        continue;
      }
      label.addToThread(thread);
      thread.markRead();
      processed.push(outcome);
    }

    return processed;
  }

  function processThread(thread, deps) {
    var messages = thread.getMessages();
    if (!messages.length) {
      return null;
    }

    var lastMessage = messages[messages.length - 1];
    if (!lastMessage.isUnread()) {
      return null;
    }

    var sender = parseEmailAddress(lastMessage.getFrom());
    if (!sender || isBotSender(sender.email, deps)) {
      return null;
    }

    var body = normalizeBody(lastMessage.getPlainBody() || lastMessage.getBody() || '');
    var signal = classifyIntent(body);
    if (signal.intent === 'unknown') {
      return null;
    }

    var calendar = getTargetCalendar_(deps.CalendarApp);
    var now = deps.now ? new Date(deps.now.getTime()) : new Date();
    var durationMinutes = extractDurationMinutes(body) || BOT_CONFIG.defaultMeetingDurationMinutes;
    var request = parseSchedulingRequest(body, now);
    var subject = lastMessage.getSubject() || 'Meeting';

    if ((signal.intent === 'schedule' || signal.intent === 'reschedule') && request.requestedStart) {
      if (!isSlotEligible(calendar, request.requestedStart, durationMinutes, deps.CalendarApp)) {
        var alternatives = getAvailableSlots({
          calendar: calendar,
          startDate: request.requestedStart,
          durationMinutes: durationMinutes,
          maxSlots: BOT_CONFIG.maxSlotsPerReply,
          lookAheadDays: BOT_CONFIG.lookAheadDays,
          preferredDate: startOfDay(request.requestedStart)
        }, deps.CalendarApp);
        replyWithAlternatives(thread, sender, alternatives, durationMinutes, signal.intent === 'reschedule');
        return { action: 'replied-with-alternatives', email: sender.email };
      }

      createMeeting(calendar, {
        sender: sender,
        subject: subject,
        body: body,
        start: request.requestedStart,
        durationMinutes: durationMinutes
      });
      thread.reply(buildConfirmationReply(sender.name, request.requestedStart, durationMinutes));
      return { action: 'scheduled', email: sender.email, start: request.requestedStart };
    }

    if (signal.intent === 'cancel' && request.requestedStart) {
      var cancelled = cancelMatchingEvent(calendar, sender.email, request.requestedStart, durationMinutes, deps.CalendarApp);
      if (cancelled) {
        thread.reply(buildCancellationReply(sender.name, request.requestedStart));
        return { action: 'cancelled', email: sender.email, start: request.requestedStart };
      }
    }

    var slots = getAvailableSlots({
      calendar: calendar,
      startDate: now,
      durationMinutes: durationMinutes,
      maxSlots: BOT_CONFIG.maxSlotsPerReply,
      lookAheadDays: BOT_CONFIG.lookAheadDays,
      preferredDate: request.preferredDate
    }, deps.CalendarApp);

    if (!slots.length) {
      thread.reply(buildNoAvailabilityReply(sender.name));
      return { action: 'replied-no-availability', email: sender.email };
    }

    thread.reply(buildAvailabilityReply(sender.name, slots, durationMinutes, signal.intent === 'reschedule'));
    return { action: 'replied-with-slots', email: sender.email };
  }

  function getGoogleDeps() {
    return {
      CalendarApp: CalendarApp,
      GmailApp: GmailApp,
      Session: Session,
      now: new Date()
    };
  }

  function ensureLabel_(gmailApp, name) {
    return gmailApp.getUserLabelByName(name) || gmailApp.createLabel(name);
  }

  function getTargetCalendar_(calendarApp) {
    if (BOT_CONFIG.calendarId && BOT_CONFIG.calendarId !== 'REPLACE_WITH_TARGET_CALENDAR_ID') {
      return calendarApp.getCalendarById(BOT_CONFIG.calendarId);
    }
    return calendarApp.getDefaultCalendar();
  }

  function isBotSender(email, deps) {
    if (!email) {
      return true;
    }

    if (BOT_CONFIG.botEmail && email.toLowerCase() === BOT_CONFIG.botEmail.toLowerCase()) {
      return true;
    }

    var activeEmail = '';
    try {
      activeEmail = deps.Session.getActiveUser().getEmail();
    } catch (error) {
      activeEmail = '';
    }
    return !!activeEmail && email.toLowerCase() === activeEmail.toLowerCase();
  }

  function createMeeting(calendar, details) {
    var end = new Date(details.start.getTime() + details.durationMinutes * 60000);
    var title = 'Meeting with ' + (details.sender.name || details.sender.email);
    var description = [
      'Scheduled automatically by the scheduler bot.',
      '',
      'From: ' + details.sender.email,
      'Original subject: ' + details.subject,
      '',
      'Original message:',
      details.body
    ].join('\n');

    return calendar.createEvent(title, details.start, end, {
      description: description,
      guests: details.sender.email,
      sendInvites: true
    });
  }

  function cancelMatchingEvent(calendar, email, requestedStart, durationMinutes, calendarApp) {
    var requestedEnd = new Date(requestedStart.getTime() + durationMinutes * 60000);
    var events = calendar.getEvents(
      new Date(requestedStart.getTime() - 6 * 3600000),
      new Date(requestedEnd.getTime() + 6 * 3600000)
    );

    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (isOutOfOfficeEvent(event, calendarApp)) {
        continue;
      }
      if (!hasMatchingGuest(event, email) && !titleMatchesEmail(event, email)) {
        continue;
      }
      if (!intervalsOverlap(event.getStartTime(), event.getEndTime(), requestedStart, requestedEnd)) {
        continue;
      }
      event.deleteEvent();
      return true;
    }

    return false;
  }

  function hasMatchingGuest(event, email) {
    try {
      return !!event.getGuestByEmail(email);
    } catch (error) {
      return false;
    }
  }

  function titleMatchesEmail(event, email) {
    var title = (event.getTitle() || '').toLowerCase();
    return title.indexOf(email.toLowerCase()) >= 0;
  }

  function isSlotEligible(calendar, start, durationMinutes, calendarApp) {
    var end = new Date(start.getTime() + durationMinutes * 60000);
    var weekdayWindows = BOT_CONFIG.weeklyAvailability[start.getDay()] || [];
    if (!slotFallsInsideWindows(start, end, weekdayWindows)) {
      return false;
    }
    return !hasConflict(calendar, start, end, calendarApp);
  }

  function slotFallsInsideWindows(start, end, windows) {
    var startMinutes = start.getHours() * 60 + start.getMinutes();
    var endMinutes = end.getHours() * 60 + end.getMinutes();

    for (var i = 0; i < windows.length; i += 1) {
      var window = windows[i];
      var windowStart = timeToMinutes(window.start);
      var windowEnd = timeToMinutes(window.end);
      if (startMinutes >= windowStart && endMinutes <= windowEnd) {
        return true;
      }
    }

    return false;
  }

  function getAvailableSlots(options, calendarApp) {
    var maxSlots = options.maxSlots || BOT_CONFIG.maxSlotsPerReply;
    var durationMinutes = options.durationMinutes || BOT_CONFIG.defaultMeetingDurationMinutes;
    var startDate = roundUpToNextHalfHour(options.startDate || new Date());
    var lookAheadDays = options.lookAheadDays || BOT_CONFIG.lookAheadDays;
    var preferredDate = options.preferredDate ? startOfDay(options.preferredDate) : null;
    var slots = [];
    var searchDays = buildSearchDays(startDate, lookAheadDays, preferredDate);

    for (var i = 0; i < searchDays.length; i += 1) {
      if (slots.length >= maxSlots) {
        break;
      }

      var day = searchDays[i];
      var windows = BOT_CONFIG.weeklyAvailability[day.getDay()] || [];
      if (!windows.length) {
        continue;
      }

      for (var j = 0; j < windows.length; j += 1) {
        var window = windows[j];
        var windowStart = applyTime(day, window.start);
        var windowEnd = applyTime(day, window.end);
        var candidate = new Date(windowStart.getTime());

        if (sameDay(day, startDate) && candidate < startDate) {
          candidate = roundUpToNextHalfHour(startDate);
        }

        while (candidate.getTime() + durationMinutes * 60000 <= windowEnd.getTime()) {
          var candidateEnd = new Date(candidate.getTime() + durationMinutes * 60000);
          if (!hasConflict(options.calendar, candidate, candidateEnd, calendarApp)) {
            slots.push(new Date(candidate.getTime()));
            if (slots.length >= maxSlots) {
              break;
            }
          }
          candidate = new Date(candidate.getTime() + 30 * 60000);
        }
      }
    }

    slots.sort(function (a, b) { return a.getTime() - b.getTime(); });
    return slots.slice(0, maxSlots);
  }

  function buildSearchDays(startDate, lookAheadDays, preferredDate) {
    var days = [];

    if (preferredDate && preferredDate.getTime() >= startOfDay(startDate).getTime()) {
      days.push(new Date(preferredDate.getTime()));
    }

    for (var i = 0; i < lookAheadDays; i += 1) {
      var day = addDays(startOfDay(startDate), i);
      if (preferredDate && sameDay(day, preferredDate)) {
        continue;
      }
      days.push(day);
    }

    return days;
  }

  function hasConflict(calendar, start, end, calendarApp) {
    var events = calendar.getEvents(start, end);
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (isOutOfOfficeEvent(event, calendarApp)) {
        return true;
      }
      if (intervalsOverlap(event.getStartTime(), event.getEndTime(), start, end)) {
        return true;
      }
    }
    return false;
  }

  function isOutOfOfficeEvent(event, calendarApp) {
    try {
      if (event.getEventType && event.getEventType() === calendarApp.EventType.OUT_OF_OFFICE) {
        return true;
      }
    } catch (error) {
      // Ignore and fall back to title-based detection.
    }

    var title = ((event.getTitle && event.getTitle()) || '').toLowerCase();
    if (title.indexOf('out of office') >= 0 || title.indexOf('ooo') >= 0 || title.indexOf('vacation') >= 0) {
      return true;
    }

    return false;
  }

  function classifyIntent(body) {
    var normalized = body.toLowerCase();
    if (/\b(cancel|call off|drop)\b/.test(normalized)) {
      return { intent: 'cancel' };
    }
    if (/\b(reschedule|move|push back|change time)\b/.test(normalized)) {
      return { intent: 'reschedule' };
    }
    if (/\b(schedule|meeting|meet|call|sync|chat|connect|available|availability|time works)\b/.test(normalized)) {
      return { intent: 'schedule' };
    }
    return { intent: 'unknown' };
  }

  function parseSchedulingRequest(body, referenceDate) {
    var normalized = body.toLowerCase();
    var durationMinutes = extractDurationMinutes(normalized) || BOT_CONFIG.defaultMeetingDurationMinutes;
    var explicitDate = extractExplicitDate(normalized, referenceDate);
    var relativeDate = explicitDate || extractRelativeDate(normalized, referenceDate);
    var weekdayDate = relativeDate || extractWeekdayDate(normalized, referenceDate);
    var chosenDate = weekdayDate;
    var timeOfDay = extractTimeOfDay(normalized);
    var requestedStart = null;

    if (chosenDate && timeOfDay) {
      requestedStart = new Date(chosenDate.getTime());
      requestedStart.setHours(timeOfDay.hours, timeOfDay.minutes, 0, 0);
    }

    return {
      durationMinutes: durationMinutes,
      preferredDate: chosenDate,
      requestedStart: requestedStart
    };
  }

  function extractDurationMinutes(body) {
    var hourMatch = body.match(/(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs)\b/);
    if (hourMatch) {
      return Math.round(parseFloat(hourMatch[1]) * 60);
    }

    var minuteMatch = body.match(/(\d+)\s*(minute|minutes|min|mins)\b/);
    if (minuteMatch) {
      return parseInt(minuteMatch[1], 10);
    }

    return null;
  }

  function extractRelativeDate(body, referenceDate) {
    if (/\btoday\b/.test(body)) {
      return startOfDay(referenceDate);
    }
    if (/\btomorrow\b/.test(body)) {
      return addDays(startOfDay(referenceDate), 1);
    }
    return null;
  }

  function extractWeekdayDate(body, referenceDate) {
    for (var i = 0; i < WEEKDAY_NAMES.length; i += 1) {
      var weekday = WEEKDAY_NAMES[i];
      var pattern = new RegExp('\\b(?:next\\s+)?' + weekday + '(?:day)?\\b');
      if (pattern.test(body)) {
        return nextWeekday(referenceDate, i, /\bnext\s+/.test(body));
      }
    }
    return null;
  }

  function extractExplicitDate(body, referenceDate) {
    var isoMatch = body.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    if (isoMatch) {
      return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    }

    var slashMatch = body.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
    if (slashMatch) {
      var month = Number(slashMatch[1]) - 1;
      var day = Number(slashMatch[2]);
      var year = slashMatch[3] ? Number(slashMatch[3]) : inferYear(referenceDate, month, day);
      return new Date(year, month, day);
    }

    var monthNameMatch = body.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/);
    if (monthNameMatch && MONTH_NAMES.hasOwnProperty(monthNameMatch[1])) {
      var namedMonth = MONTH_NAMES[monthNameMatch[1]];
      var namedDay = Number(monthNameMatch[2]);
      var namedYear = monthNameMatch[3] ? Number(monthNameMatch[3]) : inferYear(referenceDate, namedMonth, namedDay);
      return new Date(namedYear, namedMonth, namedDay);
    }

    var reverseMonthMatch = body.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s+(20\d{2}))?\b/);
    if (reverseMonthMatch && MONTH_NAMES.hasOwnProperty(reverseMonthMatch[2])) {
      var reversedMonth = MONTH_NAMES[reverseMonthMatch[2]];
      var reversedDay = Number(reverseMonthMatch[1]);
      var reversedYear = reverseMonthMatch[3] ? Number(reverseMonthMatch[3]) : inferYear(referenceDate, reversedMonth, reversedDay);
      return new Date(reversedYear, reversedMonth, reversedDay);
    }

    return null;
  }

  function inferYear(referenceDate, month, day) {
    var candidate = new Date(referenceDate.getFullYear(), month, day);
    if (candidate.getTime() < startOfDay(referenceDate).getTime()) {
      return referenceDate.getFullYear() + 1;
    }
    return referenceDate.getFullYear();
  }

  function extractTimeOfDay(body) {
    var match = body.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (!match) {
      return null;
    }

    var hours = Number(match[1]) % 12;
    var minutes = match[2] ? Number(match[2]) : 0;
    if (match[3] === 'pm') {
      hours += 12;
    }
    return { hours: hours, minutes: minutes };
  }

  function buildAvailabilityReply(name, slots, durationMinutes, isReschedule) {
    var lines = [];
    lines.push('Hi ' + (name || 'there') + ',');
    lines.push('');
    lines.push(isReschedule
      ? 'I can move the meeting to one of these slots:'
      : 'Here are a few times that are currently open on my calendar:');
    lines.push('');
    for (var i = 0; i < slots.length; i += 1) {
      lines.push((i + 1) + '. ' + formatDateTime(slots[i]));
    }
    lines.push('');
    lines.push('Reply with the exact slot you want and I will lock it in.');
    lines.push('All times above are in India Standard Time.');
    return lines.join('\n');
  }

  function buildNoAvailabilityReply(name) {
    return [
      'Hi ' + (name || 'there') + ',',
      '',
      'I could not find a free slot in the next few weeks that fits the current availability windows.',
      'If you send a preferred day or time, I will check again.',
      '',
      'All replies are handled in India Standard Time.'
    ].join('\n');
  }

  function buildConfirmationReply(name, start, durationMinutes) {
    var end = new Date(start.getTime() + durationMinutes * 60000);
    return [
      'Hi ' + (name || 'there') + ',',
      '',
      'Confirmed for ' + formatDateTime(start) + ' to ' + formatClock(end) + ' IST.',
      'You should receive the Google Calendar invite shortly.'
    ].join('\n');
  }

  function buildCancellationReply(name, start) {
    return [
      'Hi ' + (name || 'there') + ',',
      '',
      'Cancelled the meeting scheduled for ' + formatDateTime(start) + '.'
    ].join('\n');
  }

  function replyWithAlternatives(thread, sender, slots, durationMinutes, isReschedule) {
    if (!slots.length) {
      thread.reply(buildNoAvailabilityReply(sender.name));
      return;
    }
    thread.reply(buildAvailabilityReply(sender.name, slots, durationMinutes, isReschedule));
  }

  function formatDateTime(date) {
    return Utilities.formatDate(date, BOT_CONFIG.timeZone, 'EEE, d MMM yyyy h:mm a');
  }

  function formatClock(date) {
    return Utilities.formatDate(date, BOT_CONFIG.timeZone, 'h:mm a');
  }

  function parseEmailAddress(raw) {
    if (!raw) {
      return null;
    }

    var emailMatch = raw.match(/<([^>]+)>/);
    var email = emailMatch ? emailMatch[1] : raw;
    email = email.trim().toLowerCase();
    if (email.indexOf(' ') >= 0) {
      return null;
    }

    var name = raw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
    return { email: email, name: name || email.split('@')[0] };
  }

  function normalizeBody(body) {
    return String(body || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function timeToMinutes(value) {
    var parts = value.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function applyTime(day, hhmm) {
    var date = new Date(day.getTime());
    var minutes = timeToMinutes(hhmm);
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return date;
  }

  function roundUpToNextHalfHour(date) {
    var rounded = new Date(date.getTime());
    rounded.setSeconds(0, 0);
    var minutes = rounded.getMinutes();
    var delta = minutes === 0 || minutes === 30 ? 0 : (minutes < 30 ? 30 - minutes : 60 - minutes);
    if (delta) {
      rounded = new Date(rounded.getTime() + delta * 60000);
    }
    return rounded;
  }

  function addDays(date, days) {
    var copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  function startOfDay(date) {
    var copy = new Date(date.getTime());
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function nextWeekday(referenceDate, weekday, forceNextWeek) {
    var candidate = startOfDay(referenceDate);
    var diff = (weekday - candidate.getDay() + 7) % 7;
    if (diff === 0 || forceNextWeek) {
      diff += 7;
    }
    return addDays(candidate, diff);
  }

  function intervalsOverlap(startA, endA, startB, endB) {
    return startA.getTime() < endB.getTime() && startB.getTime() < endA.getTime();
  }

  return {
    run: run,
    processThread: processThread,
    classifyIntent: classifyIntent,
    parseSchedulingRequest: parseSchedulingRequest,
    extractDurationMinutes: extractDurationMinutes,
    getAvailableSlots: getAvailableSlots,
    isOutOfOfficeEvent: isOutOfOfficeEvent,
    isSlotEligible: isSlotEligible,
    buildAvailabilityReply: buildAvailabilityReply,
    parseEmailAddress: parseEmailAddress,
    intervalsOverlap: intervalsOverlap,
    roundUpToNextHalfHour: roundUpToNextHalfHour,
    startOfDay: startOfDay
  };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BOT_CONFIG: BOT_CONFIG,
    SchedulerBot: SchedulerBot,
    runSchedulerBot: runSchedulerBot
  };
}
