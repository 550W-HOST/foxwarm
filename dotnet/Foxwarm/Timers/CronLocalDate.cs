namespace Foxwarm.Timers;

internal enum CronUnit { Month, Day, Hour, Minute, Second }

// CronDate forward operations and the required Luxon 3.7.2 fixOffset/calendar-plus/set
// semantics. Elapsed additions and local calendar additions are deliberately separate.
// See THIRD-PARTY-NOTICES.md.
internal sealed class CronLocalDate
{
    internal readonly TimeZoneInfo Zone;
    internal long Milliseconds { get; private set; }
    internal CronLocalDate(long milliseconds, TimeZoneInfo zone) { Zone = zone; Milliseconds = milliseconds; }
    internal CronLocalDate Clone() => new(Milliseconds, Zone);
    private long Offset(long milliseconds) => (long)Zone.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds(milliseconds)).TotalMilliseconds;
    internal DateTime Local => DateTime.SpecifyKind(DateTimeOffset.FromUnixTimeMilliseconds(Milliseconds).UtcDateTime.AddMilliseconds(Offset(Milliseconds)), DateTimeKind.Unspecified);
    internal int Month => Local.Month - 1;
    internal int Day => Local.Day;
    internal int Weekday => (int)Local.DayOfWeek;
    internal int Hour => Local.Hour;
    internal int Minute => Local.Minute;
    internal int Second => Local.Second;
    private static long LocalStamp(DateTime wall) => new DateTimeOffset(DateTime.SpecifyKind(wall, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
    private long Resolve(DateTime wall, long guess)
    {
        var local = LocalStamp(wall); var utc = local - guess; var second = Offset(utc);
        if (guess == second) return utc;
        utc -= second - guess; var third = Offset(utc);
        if (second == third) return utc;
        return local - Math.Min(second, third);
    }
    private void SetLocal(DateTime wall) => Milliseconds = Resolve(wall, Offset(Milliseconds));
    private void CalendarPlus(int months = 0, int days = 0)
    {
        var wall = Local;
        if (months != 0) wall = wall.AddMonths(months);
        if (days != 0) wall = wall.AddDays(days);
        SetLocal(wall);
    }
    private void StartOf(CronUnit unit)
    {
        var wall = Local;
        var day = unit == CronUnit.Month ? 1 : wall.Day;
        var hour = unit is CronUnit.Month or CronUnit.Day ? 0 : wall.Hour;
        var minute = unit is CronUnit.Month or CronUnit.Day or CronUnit.Hour ? 0 : wall.Minute;
        var second = unit == CronUnit.Second ? wall.Second : 0;
        SetLocal(new DateTime(wall.Year, wall.Month, day, hour, minute, second, DateTimeKind.Unspecified));
    }
    internal void SetMilliseconds(int milliseconds)
    {
        var wall = Local; SetLocal(new DateTime(wall.Year, wall.Month, wall.Day, wall.Hour, wall.Minute, wall.Second, milliseconds, DateTimeKind.Unspecified));
    }
    internal bool LastDay()
    {
        var probe = Clone(); probe.CalendarPlus(days: 1); probe.StartOf(CronUnit.Day); return probe.Month != Month;
    }
    internal bool LastWeekday()
    {
        var probe = Clone(); probe.CalendarPlus(days: 7); probe.StartOf(CronUnit.Day); return probe.Month != Month;
    }
    internal void Add(CronUnit unit)
    {
        var previous = Milliseconds;
        switch (unit)
        {
            case CronUnit.Month: CalendarPlus(months: 1); StartOf(unit); break;
            case CronUnit.Day: CalendarPlus(days: 1); StartOf(unit); break;
            case CronUnit.Hour:
                Milliseconds = checked(Milliseconds + 3_600_000); StartOf(unit);
                if (Milliseconds <= previous) Milliseconds = checked(Milliseconds + 3_600_000);
                break;
            case CronUnit.Minute:
                Milliseconds = checked(Milliseconds + 60_000); StartOf(unit);
                if (Milliseconds < previous) Milliseconds = checked(Milliseconds + 3_600_000);
                break;
            case CronUnit.Second:
                Milliseconds = checked(Milliseconds + 1_000); StartOf(unit);
                if (Milliseconds < previous) Milliseconds = checked(Milliseconds + 3_600_000);
                break;
            default: throw new ArgumentOutOfRangeException(nameof(unit));
        }
    }
}
