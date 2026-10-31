package autoupdate

import (
	"context"
	"testing"
	"time"

	"phyless/backend/internal/models"
)

func TestNext(t *testing.T) {
	loc := time.FixedZone("x", 8*3600)
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct {
		s           models.Schedule
		after, want string
	}{
		{models.Schedule{Kind: "hours", Every: 6}, "2026-10-31 22:10", "2026-11-01 04:10"},
		{models.Schedule{Kind: "daily", Time: "03:00"}, "2026-10-31 02:59", "2026-10-31 03:00"},
		{models.Schedule{Kind: "daily", Time: "03:00"}, "2026-10-31 03:00", "2026-11-01 03:00"},
		{models.Schedule{Kind: "daily", Time: "03:00"}, "2026-12-31 23:00", "2027-01-01 03:00"},
		// 2026-10-31 is a Saturday.
		{models.Schedule{Kind: "weekly", Weekday: 0, Time: "04:30"}, "2026-10-31 12:00", "2026-11-01 04:30"},
		{models.Schedule{Kind: "weekly", Weekday: 6, Time: "04:30"}, "2026-10-31 12:00", "2026-11-07 04:30"},
		{models.Schedule{Kind: "weekly", Weekday: 6, Time: "13:00"}, "2026-10-31 12:00", "2026-10-31 13:00"},
		{models.Schedule{Kind: "monthly", Day: 31, Time: "03:00"}, "2026-10-31 04:00", "2026-11-30 03:00"},
		{models.Schedule{Kind: "monthly", Day: 31, Time: "03:00"}, "2027-01-31 04:00", "2027-02-28 03:00"},
		{models.Schedule{Kind: "monthly", Day: 1, Time: "00:00"}, "2026-12-15 00:00", "2027-01-01 00:00"},
	}
	for _, c := range cases {
		if err := Validate(c.s); err != nil {
			t.Fatalf("%+v: %v", c.s, err)
		}
		if got := Next(c.s, at(c.after)); !got.Equal(at(c.want)) {
			t.Errorf("%+v after %s: got %s want %s", c.s, c.after, got.Format("2006-01-02 15:04"), c.want)
		}
	}
	for _, bad := range []models.Schedule{{Kind: "hours"}, {Kind: "daily", Time: "25:00"}, {Kind: "weekly", Weekday: 7, Time: "01:00"}, {Kind: "monthly", Time: "01:00"}, {Kind: "cron"}} {
		if Validate(bad) == nil {
			t.Errorf("%+v should be invalid", bad)
		}
	}
}

// A missed trigger runs once; a run that cannot persist LastRunAt does not repeat.
func TestRunnerRunsDueOnce(t *testing.T) {
	saved := time.Now().Add(-3 * time.Hour)
	p := models.AutoUpdatePolicy{ID: "p", Enabled: true, Schedule: models.Schedule{Kind: "hours", Every: 1}, UpdatedAt: saved}
	runs := 0
	r := New(func() ([]models.AutoUpdatePolicy, error) { return []models.AutoUpdatePolicy{p}, nil },
		func(context.Context, models.AutoUpdatePolicy) { runs++ })
	if d := r.tick(context.Background()); d != 0 || runs != 1 {
		t.Fatalf("first tick: sleep %v runs %d", d, runs)
	}
	if d := r.tick(context.Background()); runs != 1 || d < 59*time.Minute {
		t.Fatalf("second tick: sleep %v runs %d", d, runs)
	}
}
