// Package autoupdate decides when scheduled update policies run. It knows
// nothing about Docker: the caller supplies the policies and runs them.
package autoupdate

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"phyless/backend/internal/models"
)

// Validate reports whether s is a schedule Next can compute.
func Validate(s models.Schedule) error {
	switch s.Kind {
	case "hours":
		if s.Every < 1 || s.Every > 168 {
			return errors.New("every must be 1–168 hours")
		}
		return nil
	case "daily", "weekly", "monthly":
	default:
		return errors.New("schedule kind must be hours, daily, weekly or monthly")
	}
	if _, err := time.Parse("15:04", s.Time); err != nil {
		return errors.New("time must be HH:MM")
	}
	if s.Kind == "weekly" && (s.Weekday < 0 || s.Weekday > 6) {
		return errors.New("weekday must be 0–6")
	}
	if s.Kind == "monthly" && (s.Day < 1 || s.Day > 31) {
		return errors.New("day must be 1–31")
	}
	return nil
}

// Next is the first trigger strictly after `after`, in after's location.
// s must be valid.
func Next(s models.Schedule, after time.Time) time.Time {
	if s.Kind == "hours" {
		return after.Add(time.Duration(s.Every) * time.Hour)
	}
	clock, _ := time.Parse("15:04", s.Time)
	y, m, d := after.Date()
	at := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, clock.Hour(), clock.Minute(), 0, 0, after.Location())
	}
	switch s.Kind {
	case "daily":
		if t := at(y, m, d); t.After(after) {
			return t
		}
		return at(y, m, d+1)
	case "weekly":
		t := at(y, m, d+(s.Weekday-int(after.Weekday())+7)%7)
		if t.After(after) {
			return t
		}
		return t.AddDate(0, 0, 7)
	}
	// monthly: a day past the month's end means its last day.
	for i := 0; ; i++ {
		last := time.Date(y, m+time.Month(i)+1, 0, 0, 0, 0, 0, after.Location()).Day()
		if t := at(y, m+time.Month(i), min(s.Day, last)); t.After(after) {
			return t
		}
	}
}

// Due is when p next runs: counted from its last run, or from when it was
// saved if it never ran. Missed triggers collapse into one immediate run.
func Due(p models.AutoUpdatePolicy, loc *time.Location) time.Time {
	base := p.UpdatedAt
	if p.LastRunAt != nil && p.LastRunAt.After(base) {
		base = *p.LastRunAt
	}
	return Next(p.Schedule, base.In(loc))
}

// maxSleep bounds a wait so wall-clock jumps (suspend, NTP) are noticed.
const maxSleep = time.Hour

// Runner sleeps until the earliest due policy, runs due ones one at a time,
// and otherwise costs nothing: no polling, one timer.
type Runner struct {
	policies func() ([]models.AutoUpdatePolicy, error)
	run      func(context.Context, models.AutoUpdatePolicy)
	wake     chan struct{}
	loc      *time.Location

	mu      sync.Mutex
	started map[string]time.Time // guards against re-running if run cannot persist LastRunAt
}

func New(policies func() ([]models.AutoUpdatePolicy, error), run func(context.Context, models.AutoUpdatePolicy)) *Runner {
	return &Runner{policies: policies, run: run, wake: make(chan struct{}, 1), loc: time.Local, started: map[string]time.Time{}}
}

// Wake makes the loop re-read policies, e.g. after one was saved.
func (r *Runner) Wake() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Loop runs until ctx is done.
func (r *Runner) Loop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-r.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		timer.Reset(r.tick(ctx))
	}
}

// tick runs whatever is due and returns how long to sleep.
func (r *Runner) tick(ctx context.Context) time.Duration {
	policies, err := r.policies()
	if err != nil {
		log.Printf("autoupdate: read policies: %v", err)
		return time.Minute
	}
	sleep := maxSleep
	for _, p := range policies {
		if ctx.Err() != nil {
			return sleep
		}
		if !p.Enabled || Validate(p.Schedule) != nil {
			continue
		}
		r.mu.Lock()
		if at, ok := r.started[p.ID]; ok && (p.LastRunAt == nil || at.After(*p.LastRunAt)) {
			p.LastRunAt = &at
		}
		r.mu.Unlock()
		wait := time.Until(Due(p, r.loc))
		if wait > 0 {
			sleep = min(sleep, wait)
			continue
		}
		now := time.Now()
		r.mu.Lock()
		r.started[p.ID] = now
		r.mu.Unlock()
		r.run(ctx, p)
		// A run takes time; re-evaluate everything right away.
		return 0
	}
	return sleep
}
