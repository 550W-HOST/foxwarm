namespace Foxwarm.Timers;

// Bounded forward iteration derived from cron-parser 4.9.0. No reverse/format API.
// See THIRD-PARTY-NOTICES.md.
internal sealed class CronSchedule
{
    internal const int LoopLimit = 10_000;
    private readonly CronFields fields;
    private readonly TimeZoneInfo zone;
    private CronLocalDate current;
    private readonly long? end;
    private int? dstStart,
        dstEnd;

    internal CronSchedule(
        string expression,
        long cursor,
        TimeZoneInfo? zone = null,
        long? end = null
    )
    {
        fields = CronFields.Parse(expression);
        this.zone = zone ?? TimeZoneInfo.Local;
        current = new(cursor, this.zone);
        this.end = end;
    }

    internal CronValue[][] FieldValues =>
        fields.Values.Select(values => values.ToArray()).ToArray();

    private void Shift(CronLocalDate date, CronUnit unit)
    {
        if (unit is CronUnit.Month or CronUnit.Day)
        {
            var before = date.Milliseconds;
            date.Add(unit);
            if (before == date.Milliseconds && date.Minute == 0 && date.Second == 0)
                date.Add(CronUnit.Hour);
        }
        else
        {
            var hour = date.Hour;
            date.Add(unit);
            var after = date.Hour;
            var difference = after - hour;
            if (fields.Values[2].Length != 24)
            {
                if (difference == 2)
                    dstStart = after;
                else if (difference == 0 && date.Minute == 0 && date.Second == 0)
                    dstEnd = after;
            }
        }
    }

    private bool LastWeekday(CronLocalDate date)
    {
        foreach (var value in fields.Values[5])
        {
            if (!value.Last)
                continue;
            var first = value.Constraint![0];
            if (first is < '0' or > '9')
                throw CronFields.Invalid("Invalid last weekday expression");
            if (date.Weekday == (first - '0') % 7 && date.LastWeekday())
                return true;
        }
        return false;
    }

    internal long Next()
    {
        var date = current.Clone();
        var start = date.Milliseconds;
        for (var step = 0; step < LoopLimit; step++)
        {
            if (end is long last && last < date.Milliseconds)
                throw CronFields.Invalid("Out of the timespan range");
            var dom = CronFields.Match(date.Day, fields.Values[3]);
            if (!dom && fields.Values[3].Any(value => value.Last))
                dom = date.LastDay();
            var dow = CronFields.Match(date.Weekday, fields.Values[5]);
            if (!dow && fields.Values[5].Any(value => value.Last))
                dow = LastWeekday(date);
            var domWildcard = fields.Values[3].Length >= CronFields.MonthDays[date.Month];
            var dowWildcard = fields.Values[5].Length == 8;
            var hour = date.Hour;
            if (
                (!dom && (!dow || dowWildcard))
                || (!domWildcard && dowWildcard && !dom)
                || (domWildcard && !dowWildcard && !dow)
            )
            {
                Shift(date, CronUnit.Day);
                continue;
            }
            if (fields.Nth > 0 && Math.Ceiling(date.Day / 7d) != fields.Nth)
            {
                Shift(date, CronUnit.Day);
                continue;
            }
            if (!CronFields.Match(date.Month + 1, fields.Values[4]))
            {
                Shift(date, CronUnit.Month);
                continue;
            }
            if (!CronFields.Match(hour, fields.Values[2]))
            {
                if (dstStart != hour)
                {
                    dstStart = null;
                    Shift(date, CronUnit.Hour);
                    continue;
                }
                if (!CronFields.Match(hour - 1, fields.Values[2]))
                {
                    date.Add(CronUnit.Hour);
                    continue;
                }
            }
            else if (dstEnd == hour)
            {
                dstEnd = null;
                Shift(date, CronUnit.Hour);
                continue;
            }
            if (!CronFields.Match(date.Minute, fields.Values[1]))
            {
                Shift(date, CronUnit.Minute);
                continue;
            }
            if (!CronFields.Match(date.Second, fields.Values[0]))
            {
                Shift(date, CronUnit.Second);
                continue;
            }
            if (start == date.Milliseconds)
            {
                Shift(date, CronUnit.Second);
                continue;
            }
            if (step == LoopLimit - 1)
                break;
            current = date;
            return date.Milliseconds;
        }
        throw CronFields.Invalid("Invalid expression, loop limit exceeded");
    }
}
