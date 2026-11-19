// Builds small test APKs from a real APK's manifest, signed with Google's apksig (independent of HOTEL OS code).
// usage: java -cp apksig.jar ApkFixtures.java <source.apk> <out.apk> <versionCode> <keystore.p12> <alias>
import com.android.apksig.ApkSigner;
import java.io.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.zip.*;

public class ApkFixtures {
  public static void main(String[] a) throws Exception {
    byte[] manifest;
    try (ZipFile z = new ZipFile(a[0])) { manifest = z.getInputStream(z.getEntry("AndroidManifest.xml")).readAllBytes(); }
    // Patch android:versionCode (typed int 90) → requested value.
    byte[] pat = {(byte)0xff,(byte)0xff,(byte)0xff,(byte)0xff, 0x08,0x00,0x00,0x10, 0x5a,0x00,0x00,0x00};
    int at = indexOf(manifest, pat);
    if (at < 0 || indexOf(Arrays.copyOfRange(manifest, at + 1, manifest.length), pat) >= 0) throw new IllegalStateException("versionCode pattern not unique");
    int v = Integer.parseInt(a[2]);
    manifest[at + 8] = (byte) v; manifest[at + 9] = (byte) (v >> 8); manifest[at + 10] = (byte) (v >> 16); manifest[at + 11] = (byte) (v >> 24);
    File unsigned = File.createTempFile("unsigned", ".apk");
    try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(unsigned))) {
      out.putNextEntry(new ZipEntry("AndroidManifest.xml")); out.write(manifest); out.closeEntry();
      out.putNextEntry(new ZipEntry("assets/fixture.txt")); out.write(("HOTEL OS test fixture v" + v).getBytes()); out.closeEntry();
    }
    KeyStore ks = KeyStore.getInstance("PKCS12");
    try (InputStream in = new FileInputStream(a[3])) { ks.load(in, "fixture".toCharArray()); }
    PrivateKey key = (PrivateKey) ks.getKey(a[4], "fixture".toCharArray());
    X509Certificate cert = (X509Certificate) ks.getCertificate(a[4]);
    new ApkSigner.Builder(List.of(new ApkSigner.SignerConfig.Builder("CERT", key, List.of(cert)).build()))
        .setInputApk(unsigned).setOutputApk(new File(a[1])).setMinSdkVersion(24).setV1SigningEnabled(false).setV2SigningEnabled(true).build().sign();
    System.out.println("wrote " + a[1]);
  }
  static int indexOf(byte[] h, byte[] n) {
    outer: for (int i = 0; i + n.length <= h.length; i++) { for (int j = 0; j < n.length; j++) if (h[i + j] != n[j]) continue outer; return i; }
    return -1;
  }
}
