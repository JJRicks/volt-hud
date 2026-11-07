package com.jjricks.volt;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * Volt HUD fixture tool (it is not part of Volt and never goes into the Volt repository). It writes one ride's older
 * export files (Sensor CSV, Analysis JSON, Phone raw CSV, Motion raw CSV, Route CSV, Scooter and phone JSON) and its
 * Everything (JSON) file through Volt's own RideExportFiles.payload, so both come from the same recording.
 *
 *   synth <outdir>       a synthetic 90 s ride, built the way Volt's tests/l10n/RideExportEverythingTest builds one:
 *                        repeats, a dropped key, an identifier, a gap, a direction change, 20 Hz motion, synthetic
 *                        coordinates (10 N, 20 E). This wrote test/fixtures/everything/.
 *   real <sensors.csv> <phone.csv> <motion.csv> <rideId> <outdir>
 *                        an existing ride's recording files. Its output is private ride data: never commit it.
 *
 * Build against a read-only Volt checkout V (1.12.0+), in a scratch folder W:
 *   python3 -B V/tools/l10n/gen_catalog.py --res V/res --lang V/l10n/lang --out W/gen
 *   mkdir -p W/src/com/jjricks/volt && cp tools/fixtures/HudFixture.java W/src/com/jjricks/volt/
 *   javac -nowarn -d W/classes -sourcepath W/src:W/gen:V/src W/src/com/jjricks/volt/HudFixture.java
 *   java -Duser.timezone=UTC -cp W/classes com.jjricks.volt.HudFixture synth <outdir>
 */
public final class HudFixture {
    static final String PROFILE = "a0000000-0000-4000-8000-00000000000a";

    public static void main(String[] a) throws Exception {
        File work = Files.createTempDirectory("hud-fixture").toFile();
        try {
            RideStore rides = new RideStore(new File(work, "rides"));
            PhoneRideStore phone = new PhoneRideStore(new File(work, "phone-rides"));
            String id; File out;
            if (a[0].equals("synth")) { out = new File(a[1]); id = synth(rides, phone); }
            else {
                id = a[4]; out = new File(a[5]);
                File rd = new File(work, "rides"); rd.mkdirs();
                File pd = new File(work, "phone-rides"); pd.mkdirs();
                Files.copy(Paths.get(a[1]), new File(rd, id + ".csv").toPath());
                Files.copy(Paths.get(a[2]), new File(pd, id + "-phone.csv").toPath());
                Files.copy(Paths.get(a[3]), new File(pd, id + "-motion.csv").toPath());
                rides = new RideStore(rd); phone = new PhoneRideStore(pd);
            }
            out.mkdirs();
            File cache = new File(work, "cache"); cache.mkdirs();
            RideStore.Summary s = rides.get(id);
            PhoneRideStore.Track track = phone.load(id);
            for (RideExportFiles.Format f : new RideExportFiles.Format[]{RideExportFiles.Format.EVERYTHING_JSON, RideExportFiles.Format.SENSOR_CSV,
                    RideExportFiles.Format.ANALYSIS_JSON, RideExportFiles.Format.PHONE_RAW, RideExportFiles.Format.MOTION_RAW,
                    RideExportFiles.Format.ROUTE_CSV, RideExportFiles.Format.COMBINED_JSON}) {
                RideExportFiles.Payload p = RideExportFiles.payload(f, id, rides, s, phone, track, cache, "1.12.0");
                File dest = new File(out, RideExportFiles.name(f, id));
                try (OutputStream o = new FileOutputStream(dest)) {
                    if (p.text != null) o.write(p.text.getBytes(StandardCharsets.UTF_8));
                    else Files.copy(p.file.toPath(), o);
                }
                p.discard();
                System.out.println(dest + " " + dest.length());
            }
        } finally { delete(work); }
    }
    static void delete(File f) { File[] c = f.listFiles(); if (c != null) for (File x : c) delete(x); f.delete(); }

    /** 90 s at Volt's rates; synthetic coordinates far from anyone's home (10 N, 20 E). */
    static String synth(RideStore rides, PhoneRideStore phone) throws IOException {
        long wall = 1792026000000L, mono0 = 5_000_000L;
        int seconds = 90;
        rides.setCurrentDirection(RideStore.CurrentDirection.POSITIVE_IS_DRAW);
        String id = rides.start(PROFILE, "Synthetic, \"loop\"", wall, mono0, "Europe/Lisbon");
        phone.start(id, wall + 1264, mono0);
        StringBuilder journal = new StringBuilder(), motion = new StringBuilder();
        double lat = 10.0, lon = 20.0, alt = 300.0;
        Random r = new Random(11);
        for (int i = 1; i <= seconds; i++) {
            long mono = mono0 + i * 1000L;
            long w = wall + (mono - mono0);
            if (i == 30) { rides.markGap(w - 500, mono - 500, "bluetooth lost"); rides.heartbeat(w - 200, mono - 200); }
            if (i == 60) rides.setCurrentDirection(RideStore.CurrentDirection.NEGATIVE_IS_DRAW);
            double v = 5 + 4 * Math.sin(i / 9.0);                 // m/s
            double kmh = Math.round(v * 3.6 * 10) / 10.0;
            long fresh = mono - 200 - r.nextInt(300), slow = mono0 + (i / 10) * 10000L;
            double cur = Math.round((2 + 8 * Math.cos(i / 9.0) + (i % 13 == 0 ? -12 : 0)) * 100) / 100.0;
            double volts = Math.round((52.25 - i * 0.01) * 100) / 100.0;
            Map<String, RideStore.Sample> s = new LinkedHashMap<>();
            s.put("speed_kmh", new RideStore.Sample(kmh, null, null, 0x92, i % 7 == 0 ? fresh - 1000 : fresh));
            s.put("voltage_v", new RideStore.Sample(volts, null, null, 0x92, fresh));
            s.put("current_a", new RideStore.Sample(cur, null, null, 0x92, fresh));
            s.put("power_w", new RideStore.Sample(Math.round(volts * cur * 10) / 10.0, null, null, 0x92, fresh));
            s.put("battery_percent", new RideStore.Sample(80.0 - i / 30, "80 %", "", 0x91, slow));
            s.put("scooter_serial", new RideStore.Sample(null, "SYNTHETICSERIAL01", "", 0x70, mono0));
            s.put("driving_mode", new RideStore.Sample(2.0, "Sport", "", 0x91, mono0));
            if (i % 4 != 0) s.put("temperature_c", new RideStore.Sample(21.0 + i / 30, mono0));
            s.put("odometer_km", new RideStore.Sample(1234.5 + i * v / 1000, null, null, 0x91, slow));
            s.put("response_7b", new RideStore.Sample(null, null, null, -1, -1));
            rides.sample(w, mono, s);
            lat += v / 111194.9266;
            alt += 0.02 * v;
            long gm = mono - 40 + r.nextInt(5);
            journal.append(PhoneRideStore.row("GPS", w - 40, gm, lat, lon, i == 45 ? 50f : 3.5f, i % 9 == 0 ? null : v + 0.1 * r.nextGaussian(), .2f,
                    Math.round((alt + 0.5 * r.nextGaussian()) * 10) / 10.0, 4.0f));
            journal.append(PhoneRideStore.row("PRESSURE", w + 1264 + 5, mono - 10, (float) (1000 - alt / 8.3)));
            journal.append(PhoneRideStore.row("TELEMETRY", w + 1264 + 6, mono, kmh, Math.round(volts * cur * 10) / 10.0, 80.0, fresh, fresh, slow));
            journal.append(PhoneRideStore.row("MOTION", w + 1264 + 7, mono + 7, 20, i % 2 == 0 ? null : 1.25));
            for (int k = 0; k < 20; k++) {
                long t = mono - 1000 + k * 50 + r.nextInt(3);
                double z = 9.81 + 0.5 * Math.sin(k + i) ;
                motion.append(t).append(',').append(String.format(Locale.ROOT, "%.4f,%.4f,%.4f,", 0.6 * z, 0.0, 0.8 * z))
                        .append(k == 3 ? "" : String.format(Locale.ROOT, "%.4f", 0.01 * k)).append(String.format(Locale.ROOT, ",0.02,%.4f,0.0,0.1,%.4f,", z - 9.81, z - 9.81))
                        .append(String.format(Locale.ROOT, "0.0,0.0,%.6f,%.6f,3\n", Math.sin(i / 50.0), Math.cos(i / 50.0)));
            }
            if (i == 30) journal.append(PhoneRideStore.row("GAP", w + 1264, mono));
            if (i % 10 == 0) { phone.appendBatch(id, journal.toString(), motion.toString()); journal.setLength(0); motion.setLength(0); }
        }
        rides.setNotes("Synthetic note");
        long end = mono0 + seconds * 1000L + 2000;
        phone.appendBatch(id, journal.toString(), motion.toString());
        phone.stop(id, wall + 1264 + (end - mono0), end);
        rides.stop(wall + (end - mono0), end);
        return id;
    }
}
