package cn.toside.music.mobile.crypto;

import android.util.Base64;

import java.security.Key;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.KeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

import javax.crypto.Cipher;

public class RSA {
  static final String PADDING_OAEPWithSHA1AndMGF1Padding = "RSA/ECB/OAEPWithSHA1AndMGF1Padding";
  static final String PADDING_NoPadding = "RSA/ECB/NoPadding";
  public static KeyPair getKeyPair() {
    KeyPair kp = null;
    try {
      KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
      kpg.initialize(2048);
      kp = kpg.generateKeyPair();
    } catch (Exception e) {
      e.printStackTrace();
    }

    return kp;
  }

   public static String encryptRSAToString(String decryptedBase64, String publicKey, String padding) {
    String encryptedBase64 = "";
    try {
      KeyFactory keyFac = KeyFactory.getInstance("RSA");
      KeySpec keySpec = new X509EncodedKeySpec(Base64.decode(publicKey.trim().getBytes(), Base64.DEFAULT));
      Key key = keyFac.generatePublic(keySpec);

      // get an RSA cipher object and print the provider
      final Cipher cipher = Cipher.getInstance(padding);
      // encrypt the plain text using the public key
      cipher.init(Cipher.ENCRYPT_MODE, key);

      byte[] encryptedBytes = cipher.doFinal(Base64.decode(decryptedBase64, Base64.DEFAULT));
      encryptedBase64 = new String(Base64.encode(encryptedBytes, Base64.NO_WRAP));
    } catch (Exception e) {
      e.printStackTrace();
    }

    return encryptedBase64;
  }

  public static String decryptRSAToString(String encryptedBase64, String privateKey, String padding) {

    String decryptedString = "";
    try {
      KeyFactory keyFac = KeyFactory.getInstance("RSA");
      KeySpec keySpec = new PKCS8EncodedKeySpec(Base64.decode(privateKey.trim().getBytes(), Base64.DEFAULT));
      Key key = keyFac.generatePrivate(keySpec);

      // get an RSA cipher object and print the provider
      final Cipher cipher = Cipher.getInstance(padding);
      // encrypt the plain text using the public key
      cipher.init(Cipher.DECRYPT_MODE, key);

      byte[] encryptedBytes = Base64.decode(encryptedBase64, Base64.DEFAULT);
      byte[] decryptedBytes = cipher.doFinal(encryptedBytes);
      decryptedString = new String(decryptedBytes);
    } catch (Exception e) {
      e.printStackTrace();
    }

    return decryptedString;
  }
}
