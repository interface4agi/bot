const test = require('node:test');
const assert = require('node:assert/strict');

global.Utilities = {
  formatDate(date, timeZone, pattern) {
    const formatters = {
      'EEE, d MMM yyyy h:mm a': new Intl.DateTimeFormat('en-IN', {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }),
      'h:mm a': new Intl.DateTimeFormat('en-IN', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })
    };
    return formatters[pattern].format(date).replace(',', '');
  }
};

const { BOT_CONFIG, SchedulerBot } = require('../apps-script/calendar_scheduler_bot');

function buildMockEvent(start, end, options = {}) {
  return {
    getStartTime: () => start,
    getEndTime: () => end,
    getTitle: () => options.title || '',
    getEventType: () => options.eventType || 'DEFAULT',
    getGuestByEmail: (email) => (options.guests || []).includes(email) ? { email } : null,
    deleteEvent: () => {
      options.deleted = true;
    }
  };
}

function buildMockCalendar(events) {
  return {
    getEvents(start, end) {
      return events.filter((event) => SchedulerBot.intervalsOverlap(
        event.getStartTime(),
        event.getEndTime(),
        start,
        end
      ));
    }
  };
}

test('extracts meeting duration from hours and minutes', () => {
  assert.equal(SchedulerBot.extractDurationMinutes('please block 45 minutes'), 45);
  assert.equal(SchedulerBot.extractDurationMinutes('let us meet for 1.5 hours'), 90);
});

test('parses weekday and time into the next concrete slot', () => {
  const reference = new Date('2026-03-23T09:00:00+05:30');
  const parsed = SchedulerBot.parseSchedulingRequest(
    'Can we do Tuesday at 8:30am for 45 minutes?',
    reference
  );

  assert.ok(parsed.requestedStart);
  assert.equal(parsed.requestedStart.getFullYear(), 2026);
  assert.equal(parsed.requestedStart.getMonth(), 2);
  assert.equal(parsed.requestedStart.getDate(), 24);
  assert.equal(parsed.requestedStart.getHours(), 8);
  assert.equal(parsed.requestedStart.getMinutes(), 30);
  assert.equal(parsed.durationMinutes, 45);
});

test('finds available slots while skipping busy events and OOO blocks', () => {
  const busyEvent = buildMockEvent(
    new Date('2026-03-23T14:00:00+05:30'),
    new Date('2026-03-23T14:30:00+05:30')
  );
  const outOfOfficeEvent = buildMockEvent(
    new Date('2026-03-23T20:00:00+05:30'),
    new Date('2026-03-23T21:00:00+05:30'),
    { eventType: 'OUT_OF_OFFICE', title: 'Out of office' }
  );
  const calendar = buildMockCalendar([busyEvent, outOfOfficeEvent]);
  const calendarApp = { EventType: { OUT_OF_OFFICE: 'OUT_OF_OFFICE' } };

  const slots = SchedulerBot.getAvailableSlots({
    calendar,
    startDate: new Date('2026-03-23T13:10:00+05:30'),
    durationMinutes: 30,
    maxSlots: 4,
    lookAheadDays: 2
  }, calendarApp);

  assert.equal(slots.length, 4);
  assert.deepEqual(
    slots.map((slot) => slot.toISOString()),
    [
      '2026-03-23T09:00:00.000Z',
      '2026-03-23T09:30:00.000Z',
      '2026-03-23T10:00:00.000Z',
      '2026-03-23T15:30:00.000Z'
    ]
  );
});

test('rejects slots that overlap out-of-office by event type or title fallback', () => {
  const typedOooCalendar = buildMockCalendar([
    buildMockEvent(
      new Date('2026-03-24T20:00:00+05:30'),
      new Date('2026-03-24T21:00:00+05:30'),
      { eventType: 'OUT_OF_OFFICE', title: 'OOO' }
    )
  ]);
  const titleFallbackCalendar = buildMockCalendar([
    buildMockEvent(
      new Date('2026-03-24T22:30:00+05:30'),
      new Date('2026-03-24T23:30:00+05:30'),
      { title: 'Vacation' }
    )
  ]);
  const calendarApp = { EventType: { OUT_OF_OFFICE: 'OUT_OF_OFFICE' } };

  assert.equal(
    SchedulerBot.isSlotEligible(
      typedOooCalendar,
      new Date('2026-03-24T20:00:00+05:30'),
      30,
      calendarApp
    ),
    false
  );
  assert.equal(
    SchedulerBot.isSlotEligible(
      titleFallbackCalendar,
      new Date('2026-03-24T22:30:00+05:30'),
      30,
      calendarApp
    ),
    false
  );
});

test('builds a reply with the next offered slots in IST', () => {
  const slots = [
    new Date('2026-03-26T14:00:00+05:30'),
    new Date('2026-03-26T20:00:00+05:30')
  ];

  const reply = SchedulerBot.buildAvailabilityReply('Alex', slots, BOT_CONFIG.defaultMeetingDurationMinutes, false);

  assert.match(reply, /Hi Alex/);
  assert.match(reply, /Thu 26 Mar, 2026, 2:00 pm/i);
  assert.match(reply, /India Standard Time/);
});
