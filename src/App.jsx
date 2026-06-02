import { useEffect, useRef, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useSunPosition } from './hooks/useSunPosition'

const SG_CENTER = [103.8198, 1.3521]
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const POSTAL_CODE = '545542'

// SunCalc azimuth: from south, CW in radians
// Mapbox directional direction: [azimuth_deg from north CW, polar_deg 0=zenith 90=horizon]
function sunToMapboxDirection(azimuth, altitude) {
  const bearingDeg = ((azimuth * 180) / Math.PI + 180) % 360
  const altitudeDeg = (altitude * 180) / Math.PI
  const polar = Math.max(1, Math.min(90, 90 - altitudeDeg))
  return { azimuth: bearingDeg, polar }
}

// Map sun altitude to Standard-style light preset (affects bg colour, roads, water, atmosphere)
function toPreset(altDeg) {
  if (altDeg > 6)  return 'day'
  if (altDeg > -6) return 'dusk'
  return 'night'
}

function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function minutesToTimeLabel(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function buildDate(dateStr, minuteOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  return dt
}

export default function App() {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)
  const prevPresetRef = useRef(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [mapError, setMapError] = useState(null)

  const [dateStr, setDateStr] = useState(toDateString(new Date()))
  const [minuteOfDay, setMinuteOfDay] = useState(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  })
  const [postalInput, setPostalInput] = useState(POSTAL_CODE)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)

  const selectedDate = buildDate(dateStr, minuteOfDay)
  const sun = useSunPosition({ date: selectedDate, lat: SG_CENTER[1], lng: SG_CENTER[0] })
  const sliderMinutes = Math.round(minuteOfDay / 15) * 15
  const altDeg = (sun.altitude * 180) / Math.PI

  const snapToNow = useCallback(() => {
    const now = new Date()
    setDateStr(toDateString(now))
    setMinuteOfDay(now.getHours() * 60 + now.getMinutes())
  }, [])

  const searchPostal = useCallback(async (code) => {
    const map = mapRef.current
    if (!map || !code.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(code.trim())}.json?country=sg&access_token=${MAPBOX_TOKEN}`
      )
      const data = await res.json()
      const coords = data.features?.[0]?.center
      if (!coords) { setSearchError('Postal code not found'); return }
      // Pan only — preserve current zoom
      map.easeTo({ center: coords, duration: 800 })
    } catch {
      setSearchError('Search failed')
    } finally {
      setSearching(false)
    }
  }, [])

  // Map init — Standard style is required for cast-shadows
  useEffect(() => {
    if (!MAPBOX_TOKEN || mapRef.current) return

    if (!mapboxgl.supported()) {
      setMapError('WebGL is not supported in your browser.')
      return
    }

    mapboxgl.accessToken = MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/standard',
      center: SG_CENTER,
      zoom: 17,
      pitch: 60,
      bearing: -20,
      antialias: true,
    })

    mapRef.current = map

    map.on('load', async () => {
      // Geocode postal code and fly there
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${POSTAL_CODE}.json?country=sg&access_token=${MAPBOX_TOKEN}`
        )
        const data = await res.json()
        const coords = data.features?.[0]?.center
        if (coords) {
          map.jumpTo({ center: coords })   // zoom/pitch/bearing already set at init
        }
      } catch (e) {
        console.warn('[geocode]', e)
      }

      map.addControl(new mapboxgl.NavigationControl(), 'top-right')
      setMapLoaded(true)
    })

    map.on('error', (e) => {
      console.error('[mapbox]', e.error)
      const s = e.error?.status
      if (s === 401) setMapError('Invalid Mapbox token (401).')
      else if (s === 403) setMapError('Mapbox token forbidden (403).')
    })

    return () => {
      setMapLoaded(false)
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Lighting — runs on every sun position change
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Only update lightPreset when the category changes (day/dusk/night) — calling it
    // on every tick triggers a full style re-render and causes visible flickering
    const preset = toPreset(altDeg)
    if (preset !== prevPresetRef.current) {
      try {
        map.setConfigProperty('basemap', 'lightPreset', preset)
        prevPresetRef.current = preset
      } catch (_) {}
    }

    try {
      if (!sun.isDaytime) {
        // Night / twilight: no directional, dim ambient
        const twilight = Math.max(0, Math.min(1, (altDeg + 6) / 6))
        map.setLights([{
          id: 'ambient',
          type: 'ambient',
          properties: { color: '#3a4a6a', intensity: 0.3 + twilight * 0.35 },
        }])
      } else {
        const { azimuth, polar } = sunToMapboxDirection(sun.azimuth, sun.altitude)
        const t = Math.max(0, Math.min(1, sun.altitude / (Math.PI / 2)))

        map.setLights([
          {
            id: 'sun',
            type: 'directional',
            properties: {
              color: t > 0.25 ? '#ffffff' : '#ffcc88',
              intensity: 0.7 + t * 0.3,   // always bright so shadow edges are sharp
              direction: [azimuth, polar],
              'cast-shadows': true,
              'shadow-intensity': 1,        // maximum shadow darkness
            },
          },
          {
            id: 'ambient',
            type: 'ambient',
            properties: { color: '#c8daf0', intensity: 0.1 }, // low ambient = deep shadows
          },
        ])
      }
    } catch (err) {
      console.warn('[setLights]', err)
    }
  }, [sun.altitude, sun.azimuth, sun.isDaytime, mapLoaded, altDeg])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-100">
        <div className="max-w-md text-center p-8 bg-white rounded-2xl border border-slate-200 shadow-xl">
          <h1 className="text-xl font-bold mb-3 text-slate-800">Mapbox Token Required</h1>
          <p className="text-slate-500 mb-4 text-sm">
            Add your token to <code className="bg-slate-100 px-1 rounded text-amber-600">.env</code>:
          </p>
          <pre className="bg-slate-100 text-green-700 text-sm p-4 rounded-lg text-left">
            VITE_MAPBOX_TOKEN=pk.eyJ1Ijoi...
          </pre>
          <p className="text-slate-400 text-xs mt-3">Then restart <code>pnpm dev</code>.</p>
        </div>
      </div>
    )
  }

  const isDark = altDeg <= -6

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-100">
      {/* Map canvas — no Tailwind positioning so Mapbox owns position:relative */}
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Loading */}
      {!mapLoaded && !mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 z-10">
          <div className="text-center">
            <div className="w-10 h-10 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-slate-400 text-sm">Loading {POSTAL_CODE}…</p>
          </div>
        </div>
      )}

      {/* Error */}
      {mapError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 max-w-sm w-full px-4">
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl text-sm shadow">
            {mapError}
          </div>
        </div>
      )}

      {/* Side panel */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-72">
        <div className={`backdrop-blur-md rounded-2xl p-4 shadow-xl border transition-colors duration-700 ${
          isDark
            ? 'bg-slate-900/90 border-slate-700'
            : 'bg-white/90 border-slate-200'
        }`}>
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h1 className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-slate-800'}`}>
              Solar Shadow · SG
            </h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              sun.isDaytime
                ? 'bg-amber-100 text-amber-700 border border-amber-200'
                : 'bg-slate-700/60 text-slate-300 border border-slate-600'
            }`}>
              {sun.isDaytime ? '☀ Day' : '☽ Night'}
            </span>
          </div>

          {/* Postal code search */}
          <div className="mb-4">
            <label className={`block text-xs mb-1 font-medium uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Postal Code
            </label>
            <form
              onSubmit={(e) => { e.preventDefault(); searchPostal(postalInput) }}
              className="flex gap-2"
            >
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="e.g. 545542"
                value={postalInput}
                onChange={(e) => { setPostalInput(e.target.value); setSearchError(null) }}
                className={`flex-1 text-sm rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent ${
                  isDark
                    ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-500'
                    : 'bg-slate-50 border-slate-300 text-slate-800 placeholder-slate-400'
                }`}
              />
              <button
                type="submit"
                disabled={searching}
                className="px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors font-medium"
              >
                {searching ? '…' : 'Go'}
              </button>
            </form>
            {searchError && (
              <p className="text-red-500 text-xs mt-1">{searchError}</p>
            )}
          </div>

          {/* Date */}
          <div className="mb-3">
            <label className={`block text-xs mb-1 font-medium uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Date
            </label>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className={`w-full text-sm rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent ${
                isDark
                  ? 'bg-slate-800 border-slate-600 text-white'
                  : 'bg-slate-50 border-slate-300 text-slate-800'
              }`}
            />
          </div>

          {/* Time */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <label className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Time
              </label>
              <span className={`text-sm font-mono font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                {minutesToTimeLabel(sliderMinutes)}
              </span>
            </div>
            <input
              type="range" min={0} max={1440} step={15} value={sliderMinutes}
              onChange={(e) => setMinuteOfDay(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(sliderMinutes / 1440) * 100}%, ${isDark ? '#475569' : '#cbd5e1'} ${(sliderMinutes / 1440) * 100}%, ${isDark ? '#475569' : '#cbd5e1'} 100%)`,
              }}
            />
            <div className={`flex justify-between text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              <span>00:00</span><span>12:00</span><span>24:00</span>
            </div>
          </div>

          {/* Now */}
          <button
            onClick={snapToNow}
            className="w-full mb-3 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            Now
          </button>

          {/* Sun stats */}
          <div className={`border-t pt-3 grid grid-cols-2 gap-2 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            <SunStat label="Altitude" value={`${altDeg.toFixed(1)}°`} dark={isDark} />
            <SunStat label="Azimuth"  value={`${(((sun.azimuth * 180) / Math.PI + 180) % 360).toFixed(1)}°`} dark={isDark} />
            <SunStat label="Sunrise"  value={sun.sunriseTime ?? '—'} dark={isDark} />
            <SunStat label="Sunset"   value={sun.sunsetTime  ?? '—'} dark={isDark} />
          </div>
        </div>
      </div>
    </div>
  )
}

function SunStat({ label, value, dark }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${dark ? 'bg-slate-800' : 'bg-slate-100'}`}>
      <div className={`text-xs mb-0.5 ${dark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</div>
      <div className={`text-sm font-mono font-semibold ${dark ? 'text-white' : 'text-slate-800'}`}>{value}</div>
    </div>
  )
}
