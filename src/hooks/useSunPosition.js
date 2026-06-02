import { useMemo } from 'react'
import SunCalc from 'suncalc'

const SG_LAT = 1.3521
const SG_LNG = 103.8198

function formatTime(date) {
  if (!date || isNaN(date.getTime())) return null
  return date.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function useSunPosition({ date, lat = SG_LAT, lng = SG_LNG }) {
  return useMemo(() => {
    if (!date || isNaN(date.getTime())) {
      return { altitude: 0, azimuth: 0, isDaytime: false, sunriseTime: null, sunsetTime: null }
    }

    const pos = SunCalc.getPosition(date, lat, lng)
    const times = SunCalc.getTimes(date, lat, lng)

    const altitude = isNaN(pos.altitude) ? 0 : pos.altitude
    const azimuth = isNaN(pos.azimuth) ? 0 : pos.azimuth

    return {
      altitude,
      azimuth,
      isDaytime: altitude > 0,
      sunriseTime: formatTime(times.sunrise),
      sunsetTime: formatTime(times.sunset),
    }
  }, [date, lat, lng])
}
